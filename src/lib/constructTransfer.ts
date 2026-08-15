import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * Build the transaction a signed intent describes.
 *
 * This is the missing half of the offline-first model. The user is offline when
 * they consent, so what they sign is the *intent* — amount, asset, recipient —
 * and never a transaction. A transaction signed at intent time would be dead on
 * arrival: its blockhash expires in roughly 60–90 seconds, and the signature
 * covers `recentBlockhash`, so it cannot be refreshed without the user's key.
 * That is to-be-fixed.md C2, and constructing here is the decided answer to it.
 *
 * It is also why `HOT_WALLET_ADDRESS` exists. The relayer cannot move a user's
 * tokens on its own authority — it moves them as **delegate**, under an on-chain
 * approval the user granted once, in a transaction they signed themselves while
 * online. The approval is the consent; the intent selects what to do with it.
 *
 * ## What this file must not do
 *
 * Constructing inverts the trust model. Everywhere else the user's signature
 * covers the instruction bytes, so a bug here would produce a transaction they
 * never agreed to and nothing external would catch it. Two rules follow:
 *
 *  1. **Every caller must run `verifyConstructedTransaction` on the output
 *     before signing it.** That check re-derives the destination independently
 *     rather than trusting the helper used below, so a bug in
 *     `getAssociatedTokenAddressSync` cannot pass its own verification.
 *  2. **`delegate` must be bound to the signed intent, not to config.** The
 *     legacy intent carries `metadata.hw` — the hot wallet the user actually
 *     approved — inside the bytes their signature covers. Passing this
 *     relayer's own key without checking it against `hw` would let a rotated or
 *     misconfigured delegate move funds under an approval that never named it.
 *     This function takes `delegate` explicitly, and deliberately does not read
 *     it from config, so that check cannot be skipped by omission.
 *
 * No I/O happens here. The blockhash and decimals are parameters because a
 * function that fetches its own inputs cannot be tested against the cases that
 * matter, and because the decimals lookup is separately cached
 * (`mintDecimals.ts`).
 */

/** SPL Token instruction data layout is identical across both programs. */
/**
 * One additional transfer bundled into a payment, in the signed intent's order.
 *
 * A fee is not a deduction and not metadata — it is a transfer the user signed,
 * settled in the same transaction, from the same account, with its own
 * idempotent ATA creation. Mirror of `FeeEntry` in rust-core/src/types.rs.
 */
export interface FeeTransfer {
  /** Recipient *wallet* address — the ATA is derived, never supplied. */
  destination: string;
  /** Amount in the mint's smallest unit. Never UI units. */
  amount: bigint;
}

export interface DelegatedTransferParams {
  /** Wallet address the funds leave. Its ATA is the source account. */
  sender: string;
  /** Recipient's *wallet* address — the ATA is derived, never supplied. */
  recipient: string;
  /** Mint of the asset being moved. */
  mint: string;
  /** Amount in the mint's smallest unit. Never UI units. */
  amount: bigint;
  /**
   * Fees settled alongside the payment, in signed-payload order.
   *
   * Each entry becomes its own TransferChecked instruction, primary recipient
   * first. Empty is the ordinary peer-to-peer case — one transfer, exactly as
   * this function behaved before fees existed.
   *
   * The sender is debited `amount + sum(fees)`; no part of that total is
   * supplied separately, so there is no second field that can disagree.
   */
  fees?: FeeTransfer[];
  /**
   * The mint's decimals, as an operand of TransferChecked.
   *
   * Not cosmetic: the token program rejects the instruction if this disagrees
   * with the mint's real value, which turns a wrong-asset bug into an on-chain
   * refusal rather than a silent transfer of the wrong thing. Resolve it with
   * `cachedDecimals`, never by assuming 6.
   */
  decimals: number;
  /** Pays the signature fee and any ATA rent. Becomes staticAccountKeys[0]. */
  feePayer: PublicKey;
  /**
   * The account the user approved as delegate on their token account.
   *
   * Must equal the hot wallet named in the signed intent — see rule 2 above.
   */
  delegate: PublicKey;
  recentBlockhash: string;
  /** Token-2022 mints must be addressed with their own program. */
  tokenProgramId?: PublicKey;
  /**
   * Prepend an idempotent create for the recipient's ATA. Default true.
   *
   * Without it, paying anyone who does not already hold the mint fails
   * deterministically at simulation — to-be-fixed.md A2. The idempotent variant
   * is a no-op when the account exists, so there is no probe-then-create race
   * and no extra round trip.
   *
   * The cost is real and lands on the relayer: ~0.002 SOL of rent per new
   * recipient, paid by `feePayer`. That is what the rolling SOL budget reserves
   * against, and why this is a parameter rather than an unconditional
   * instruction — a deployment that would rather refuse than fund arbitrary
   * accounts can turn it off and fail loudly instead.
   */
  createRecipientAta?: boolean;
}

export interface ConstructedTransfer {
  /** Unsigned. Sign only after `verifyConstructedTransaction` passes. */
  transaction: VersionedTransaction;
  /** The same transaction serialized, which is what the guard reads. */
  serialized: Buffer;
  /** Derived, not supplied — surfaced for logging and diagnostics. */
  sourceAta: PublicKey;
  destinationAta: PublicKey;
  /** Fee destination ATAs, in the same order as `fees`. */
  feeAtas: PublicKey[];
  /**
   * How many ATA creations this transaction carries.
   *
   * Every one costs the fee payer rent (~0.002 SOL), so the SOL budget must
   * reserve against this count rather than assuming at most one — a payment
   * with fees can need several in a single transaction.
   */
  ataCreationCount: number;
}

/**
 * Construct an unsigned delegated SPL transfer.
 *
 * The result carries zero-filled signature slots for every required signer, so
 * it serializes and deserializes cleanly for verification before anything signs
 * it.
 *
 * @throws {Error} if an address is not a valid public key, or the amount is not
 * positive. Both are caller errors rather than transaction failures, and a
 * transaction built from them would be rejected by the guard anyway — failing
 * here names the bad field instead.
 */
export function buildDelegatedTransfer(
  params: DelegatedTransferParams,
): ConstructedTransfer {
  const tokenProgramId = params.tokenProgramId ?? TOKEN_PROGRAM_ID;

  const sender = toPublicKey(params.sender, "sender");
  const recipient = toPublicKey(params.recipient, "recipient");
  const mint = toPublicKey(params.mint, "mint");

  if (params.amount <= 0n) {
    throw new Error(`Transfer amount must be positive, got ${params.amount}`);
  }
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 18) {
    throw new Error(
      `Mint decimals must be an integer in 0..18, got ${params.decimals}. ` +
        "Resolve it from the mint with cachedDecimals rather than assuming a value.",
    );
  }

  // `allowOwnerOffCurve: false` on all of them. A PDA cannot sign, so a PDA
  // sender could never have approved a delegate, and a PDA destination is far
  // more likely to be a caller passing a token account where a wallet belongs —
  // the exact confusion the guard's destination check exists to catch. Better
  // to refuse here, where the message can name which address was wrong.
  const sourceAta = getAssociatedTokenAddressSync(mint, sender, false, tokenProgramId);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipient, false, tokenProgramId);

  const fees = params.fees ?? [];
  const feeTargets = fees.map((fee, i) => {
    if (fee.amount <= 0n) {
      throw new Error(`Fee amount at fees[${i}] must be positive, got ${fee.amount}`);
    }
    const owner = toPublicKey(fee.destination, `fees[${i}].destination`);
    return {
      owner,
      ata: getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId),
      amount: fee.amount,
    };
  });

  // The sender is debited the payment plus every fee. Checked here because a
  // u64 per entry can still sum past u64, and an overflowed total would be a
  // transaction whose real cost nobody computed.
  const totalDebit = feeTargets.reduce((sum, f) => sum + f.amount, params.amount);
  if (totalDebit > MAX_U64) {
    throw new Error(
      `Total debit ${totalDebit} (amount plus ${feeTargets.length} fee(s)) exceeds u64`,
    );
  }

  const createAtas = params.createRecipientAta ?? true;
  const instructions: TransactionInstruction[] = [];

  // Every ATA create precedes every transfer. Ordering matters within the
  // transaction — a transfer to an account created later in the same
  // transaction fails — and grouping them keeps that true no matter how many
  // fee destinations there are.
  const ataOwners = createAtas
    ? [
      { owner: recipient, ata: destinationAta },
      ...feeTargets.map((f) => ({ owner: f.owner, ata: f.ata })),
    ]
    : [];

  // Deduplicated by ATA. A fee paid to the recipient, or two fees to the same
  // party, would otherwise emit the same create twice — harmless on-chain
  // because it is idempotent, but it would inflate the rent reservation and
  // make the instruction list misrepresent what the transaction does.
  const seenAtas = new Set<string>();
  for (const { owner, ata } of ataOwners) {
    const key = ata.toBase58();
    if (seenAtas.has(key)) continue;
    seenAtas.add(key);
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        params.feePayer,
        ata,
        owner,
        mint,
        tokenProgramId,
      ),
    );
  }

  // TransferChecked rather than Transfer, deliberately. It takes the mint and
  // decimals as operands, so the token program itself refuses a mismatch — and
  // the outbound guard can compare the mint operand directly instead of
  // inferring it from the destination derivation.
  //
  // Primary recipient first, then fees in signed-payload order. The guard
  // matches as a set and does not depend on this, but a stable order makes the
  // transaction reproducible from the intent, which is what makes a diff
  // between two builds meaningful.
  const transferTo = (destination: PublicKey, amount: bigint) =>
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destination,
      // The authority. This is the delegate, not the owner: the user approved
      // this account on their token account, and that approval is what permits
      // the move.
      params.delegate,
      amount,
      params.decimals,
      [],
      tokenProgramId,
    );

  instructions.push(transferTo(destinationAta, params.amount));
  for (const fee of feeTargets) {
    instructions.push(transferTo(fee.ata, fee.amount));
  }

  const message = new TransactionMessage({
    payerKey: params.feePayer,
    recentBlockhash: params.recentBlockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  return {
    transaction,
    serialized: Buffer.from(transaction.serialize()),
    sourceAta,
    destinationAta,
    feeAtas: feeTargets.map((f) => f.ata),
    ataCreationCount: seenAtas.size,
  };
}

/** Largest u64, the ceiling an SPL amount and the summed debit must stay under. */
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function toPublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Intent ${label} '${value}' is not a valid Solana public key`);
  }
}
