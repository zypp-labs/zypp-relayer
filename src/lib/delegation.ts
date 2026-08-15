import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "./failureCodes.js";

/**
 * Prove the relayer is actually a delegate before it signs as one.
 *
 * ## Why this is not optional
 *
 * In the offline-first model the user is not present at settlement. The relayer
 * moves their tokens under an SPL **delegate approval** they granted earlier, in
 * a transaction they signed themselves while online
 * (`zypp-pay/backend/user.ts:delegateUSDCAuthority`).
 *
 * The obvious shortcut is to trust the intent: it carries `metadata.hw`, which
 * names the hot wallet the client believes was approved. **That field is not
 * signed.** `computeCanonicalIntentId` (validate.ts) hashes exactly
 * `s, r, a, f, t, n, ts` — `metadata` is excluded, so `hw` is advisory data any
 * client can set to anything while the signature still verifies. Building an
 * authorisation check on it would be checking a value the attacker controls.
 *
 * The on-chain approval is the real authority: it is what the token program
 * enforces, it cannot be forged by editing JSON, and reading it needs no client
 * change. So this module asks the chain rather than the envelope.
 *
 * ## Why check at all, if the token program will reject anyway
 *
 * A transfer without a valid delegation fails at simulation, so nothing moves
 * either way. Checking first buys three things:
 *
 *  - **A diagnosis instead of a generic failure.** "This user has not delegated
 *    to us" and "this user delegated 5 USDC and the payment is 10" are different
 *    problems with different fixes; `custom program error: 0x4` is neither.
 *  - **A non-retriable classification.** A missing delegation is deterministic.
 *    Without this, `classifyError` may treat the RPC error as retriable and burn
 *    every attempt against a condition that cannot change.
 *  - **It runs before the fee payer spends anything.** A refused transfer that
 *    reached broadcast has already cost a signature fee and possibly ATA rent.
 */

/** What the sender's token account says about our authority over it. */
export interface DelegationCheck {
  /** The delegated allowance remaining, in the mint's base units. */
  delegatedAmount: bigint;
  /** The sender's associated token account, derived here. */
  sourceAta: PublicKey;
}

export type DelegationResult =
  | { ok: true; delegation: DelegationCheck }
  | { ok: false; failure: RelayerFailure };

/**
 * Read the sender's token account and confirm `delegate` may move `amount`.
 *
 * Checks, in order — each a distinct cause an operator would act on differently:
 *
 *   1. The token account exists. No account means the user never held this mint.
 *   2. It is not frozen. A frozen account cannot transfer regardless of approval.
 *   3. A delegate is set, and it is us.
 *   4. The delegated allowance covers the full debit (payment **plus** fees).
 *   5. The account's own balance covers the debit.
 *
 * `amount` must be the **total** the transaction will move — `PaymentPayload`'s
 * `amount` plus every fee entry. Checking only the payment would pass a
 * delegation that cannot cover the fees, and the transfer would then fail
 * partway through a multi-instruction transaction.
 *
 * Every failure is non-retriable: none of these conditions changes without the
 * user acting, so retrying burns attempts against a fixed state.
 */
export async function verifyDelegation(
  connection: Connection,
  params: {
    sender: PublicKey;
    mint: PublicKey;
    /** The key the relayer will sign with as delegate. */
    delegate: PublicKey;
    /** Total base units the transaction moves: payment + all fees. */
    amount: bigint;
    tokenProgramId: PublicKey;
  },
): Promise<DelegationResult> {
  const sourceAta = getAssociatedTokenAddressSync(
    params.mint,
    params.sender,
    false,
    params.tokenProgramId,
  );

  let account;
  try {
    account = await getAccount(connection, sourceAta, undefined, params.tokenProgramId);
  } catch (e) {
    // Distinguishing "no such account" from "the RPC is down" is not reliably
    // possible from the error alone, and the safe reading is the one that does
    // not sign: refuse, and say which account could not be read.
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "SOURCE_ACCOUNT_UNREADABLE",
        `Could not read the sender's token account ${sourceAta.toBase58()} for mint ` +
          `${params.mint.toBase58()}: ${e instanceof Error ? e.message : String(e)}. ` +
          "The account may not exist, or the RPC may be unavailable. Not co-signed.",
      ),
    };
  }

  if (account.isFrozen) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "SOURCE_ACCOUNT_FROZEN",
        `The sender's token account ${sourceAta.toBase58()} is frozen and cannot transfer. ` +
          "This is set by the mint's freeze authority, not by the relayer or the user.",
      ),
    };
  }

  if (!account.delegate) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "NO_DELEGATE_APPROVAL",
        `The sender has not approved any delegate on ${sourceAta.toBase58()}, so the relayer ` +
          "has no authority to move these tokens. The user must complete the one-time " +
          "approval before offline payments can settle.",
      ),
    };
  }

  if (!account.delegate.equals(params.delegate)) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "DELEGATE_MISMATCH",
        `The sender approved ${account.delegate.toBase58()} as delegate, but this relayer holds ` +
          `${params.delegate.toBase58()}. The relayer will not sign for an approval that does ` +
          "not name it. If the delegate key was rotated, users must re-approve the new one — " +
          "an SPL approval names exactly one delegate and does not carry over.",
      ),
    };
  }

  if (account.delegatedAmount < params.amount) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "DELEGATION_EXHAUSTED",
        `The approved allowance is ${account.delegatedAmount} base units but this payment moves ` +
          `${params.amount} (including fees). An SPL approval is a decreasing budget, not a ` +
          "standing permission — it is consumed by each transfer and must be renewed.",
      ),
    };
  }

  // Checked separately from the allowance because the causes differ: an
  // exhausted delegation is renewed by re-approving, an insufficient balance is
  // fixed by funding. Reporting one as the other sends the user to the wrong
  // remedy.
  if (account.amount < params.amount) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "INSUFFICIENT_BALANCE",
        `The sender's balance is ${account.amount} base units but this payment moves ` +
          `${params.amount} (including fees).`,
      ),
    };
  }

  return {
    ok: true,
    delegation: { delegatedAmount: account.delegatedAmount, sourceAta },
  };
}
