import {
  VersionedTransaction,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "./failureCodes.js";

/**
 * Outbound correctness gate for relayer-constructed transactions.
 *
 * `feePayer.ts:verifyPaymentInstructions` guards the *inbound* direction: a
 * client hands us a transaction and we check it is not obviously inconsistent
 * with its declared intent. That check is deliberately loose — it accepts any
 * SPL transfer when the envelope carries no recipient, because the envelope is
 * thin (see envelope.ts) and the client's signature is what actually binds the
 * terms.
 *
 * This module guards the *outbound* direction, and the threat model is
 * inverted. When the relayer builds the transaction, the user's signature no
 * longer covers the instruction bytes we produce — so nothing external stops a
 * construction bug from moving the wrong amount, or moving funds to the wrong
 * account. The user consented to the intent; we are asserting that what we
 * built is that intent and nothing else.
 *
 * Accordingly this check is exact, not structural. It re-derives every field
 * from the intent independently and compares value by value. "A transfer
 * instruction exists" is not a check; it is the absence of one.
 *
 * ## Why re-derive rather than inspect
 *
 * The verification must not share code with the construction path. If both
 * derive the destination account from the same helper, a bug in that helper
 * produces a wrong transaction that passes its own verification. So this file
 * takes only the raw intent fields and the serialized transaction, and computes
 * what it expects from scratch.
 */

/** Canonical SPL Token program. */
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022. Accepted, but the mint must match the intent either way. */
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Associated Token Account program — needed to derive the expected destination. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** SPL Token instruction discriminators (first data byte). */
const IX_TRANSFER = 3;
const IX_TRANSFER_CHECKED = 12;

/**
 * The economic value a transaction moves, extracted for spend policy checks.
 *
 * `mint` is null for a bare Transfer, where the mint is not an operand of the
 * instruction — the caller must then fall back to a global ceiling rather than
 * a per-asset one.
 */
export interface TransferValue {
  amount: bigint;
  mint: PublicKey | null;
}

/**
 * Extract the total SPL value a transaction moves, for spend policy checks.
 *
 * Sums **every** transfer instruction, not just the first. A payment with fees
 * is several transfers in one transaction, and valuing only one of them would
 * report less than the transaction actually moves — letting a payment slip past
 * a ceiling it should have hit by splitting value across fee entries.
 *
 * Returns null when the transaction cannot be deserialized, contains no
 * transfer, mixes mints, or overflows — a transaction that cannot be
 * unambiguously valued must not slip past spend checks.
 */
export function extractTransferValue(serialized: Buffer): TransferValue | null {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(serialized);
  } catch {
    return null;
  }

  const instructions = extractInstructions(tx);
  const token = instructions.filter(
    (ix) => ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID),
  );

  if (token.length === 0) return null;

  let total = 0n;
  let mint: PublicKey | null = null;

  for (const ix of token) {
    if (ix.data.length < 9) return null;
    const discriminator = ix.data[0];
    if (discriminator !== IX_TRANSFER && discriminator !== IX_TRANSFER_CHECKED) return null;

    const amount = readTransferAmount(ix.data);
    if (amount === null) return null;
    total += amount;

    if (discriminator === IX_TRANSFER_CHECKED && ix.keys.length >= 2) {
      const thisMint = ix.keys[1].pubkey;
      if (mint === null) {
        mint = thisMint;
      } else if (!mint.equals(thisMint)) {
        // Two mints in one transaction cannot share a single value figure —
        // base units are not commensurable across decimal scales.
        return null;
      }
    }
  }

  // A u64 per instruction can exceed a u64 in total. The ceilings compare
  // against this, so an overflowed sum would understate what moves.
  if (total > 0xffff_ffff_ffff_ffffn) return null;

  return { amount: total, mint };
}

/**
 * One transfer the user agreed to, beyond the payment itself.
 *
 * Mirrors `FeeEntry` in rust-core/src/types.rs. A fee is a transfer covered by
 * the user's signature, not a deduction applied afterwards — which is exactly
 * why it belongs in this check. An unsigned fee and a stolen transfer are the
 * same thing.
 */
export interface FeeTerm {
  /** Recipient *wallet* address — the token account is derived here. */
  destination: string;
  /** Amount in the mint's smallest unit. */
  amount: bigint;
}

/**
 * The economic terms the user signed. Mirrors `PaymentPayload` in
 * rust-core/src/types.rs — amount in base units, mint and recipient as
 * base58 addresses.
 */
export interface PaymentIntentTerms {
  /** Transfer amount in the mint's smallest unit (not UI units). */
  amount: bigint;
  /** Mint address of the asset being moved. */
  asset: string;
  /** Recipient's *wallet* address — not their token account. */
  recipient: string;
  /**
   * Fees settled in the same transaction, in signed-payload order.
   *
   * Absent or empty is the ordinary peer-to-peer case and behaves exactly as
   * this interface did before fees existed.
   */
  fees?: FeeTerm[];
}

/**
 * Thrown when a relayer-constructed transaction does not match its intent.
 *
 * A distinct class so callers can catch precisely this and route it to the
 * `OutboundVerification` failure stage. Carries the structured failure so the
 * job row records exactly which field disagreed.
 */
export class ConstructedTransactionMismatchError extends Error {
  readonly failure: RelayerFailure;

  constructor(detail: string) {
    super(`Constructed transaction does not match signed intent: ${detail}`);
    this.name = "ConstructedTransactionMismatchError";
    this.failure = relayerFailure(
      RelayerFailureStage.OutboundVerification,
      "CONSTRUCTED_TX_MISMATCH",
      this.message,
      // Never retriable: the same construction inputs produce the same wrong
      // output. Retrying burns attempts against a deterministic defect.
      false,
    );
  }
}

/**
 * Derive the Associated Token Account for (owner, mint).
 *
 * Deliberately hand-rolled rather than calling `getAssociatedTokenAddressSync`
 * from @solana/spl-token: the construction path will use that helper, and this
 * check must not inherit its bugs. PDA derivation is a stable, specified
 * algorithm — seeds are [owner, tokenProgram, mint] under the ATA program.
 */
function deriveAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

/**
 * Read a little-endian u64 amount from SPL transfer instruction data.
 *
 * Layout is `[discriminator: u8, amount: u64le, ...]` for both Transfer and
 * TransferChecked; TransferChecked appends a decimals byte we do not need here.
 */
function readTransferAmount(data: Buffer): bigint | null {
  if (data.length < 9) return null;
  return data.readBigUInt64LE(1);
}

/** Pull instructions out of a VersionedTransaction in either message shape. */
function extractInstructions(tx: VersionedTransaction): TransactionInstruction[] {
  const message = tx.message as any;

  if (Array.isArray(message.instructions) && message.instructions.length > 0) {
    return message.instructions as TransactionInstruction[];
  }

  if (Array.isArray(message.compiledInstructions)) {
    const keys: PublicKey[] = message.staticAccountKeys ?? [];
    return message.compiledInstructions.map((ci: any) => {
      const accountIndexes: number[] = ci.accountKeyIndexes ?? ci.accounts ?? [];
      return new TransactionInstruction({
        programId: keys[ci.programIdIndex],
        keys: accountIndexes.map((i) => ({
          pubkey: keys[i],
          isSigner: false,
          isWritable: false,
        })),
        data: Buffer.from(ci.data ?? []),
      });
    });
  }

  return [];
}

/** One transfer the intent says must appear, with its destination resolved. */
interface ExpectedTransfer {
  /** How this entry is named in an error: "payment", or `fees[0]`. */
  label: string;
  amount: bigint;
  /** Derived here from raw PDA seeds — never taken from the transaction. */
  destinationAta: PublicKey;
}

/** One transfer actually present in the constructed transaction. */
interface ActualTransfer {
  /** Instruction position, so an error can point at a specific one. */
  index: number;
  amount: bigint;
  destination: PublicKey;
  /** Null for a bare Transfer, where the mint is not an operand. */
  mint: PublicKey | null;
  isChecked: boolean;
}

/**
 * Assert a relayer-constructed transaction expresses exactly the signed intent.
 *
 * Call immediately after construction and **before** signing. On mismatch this
 * throws; the caller must not sign and must not broadcast.
 *
 * ## Reconciliation, not counting
 *
 * A payment may now carry fees, and each fee is its own transfer instruction —
 * so "exactly one transfer" is no longer the rule. What replaces it is a
 * **bijection**: the transfers in the transaction and the transfers the intent
 * describes must pair up one-to-one, with nothing left over on either side.
 *
 * Both directions are load-bearing, and for different reasons:
 *
 *   - An **extra** transfer moves value the user never agreed to. This is the
 *     original protection and the more obvious half.
 *   - A **missing** transfer is equally a violation. If construction silently
 *     dropped a fee entry, the payment would settle while a party the user
 *     agreed to pay went unpaid — and the transaction would look perfectly
 *     valid on-chain. Fees are not optional extras; they are terms.
 *
 * Matching is greedy over (destination, amount) pairs, and duplicates are
 * handled correctly: two fees of equal amount to the same address require two
 * matching instructions, because each expected entry consumes exactly one.
 *
 * Every destination is re-derived here from raw PDA seeds rather than read from
 * the transaction or computed with the same helper construction uses — a bug in
 * that helper must not be able to pass its own verification.
 *
 * @throws {ConstructedTransactionMismatchError}
 */
export function verifyConstructedTransaction(
  intent: PaymentIntentTerms,
  serializedTransaction: Buffer,
): void {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(serializedTransaction);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ConstructedTransactionMismatchError(
      `transaction failed to deserialize (${reason})`,
    );
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(intent.asset);
  } catch {
    throw new ConstructedTransactionMismatchError(
      `intent asset '${intent.asset}' is not a valid public key`,
    );
  }

  if (intent.amount <= 0n) {
    throw new ConstructedTransactionMismatchError(
      `intent amount must be positive, got ${intent.amount}`,
    );
  }

  const instructions = extractInstructions(tx);
  if (instructions.length === 0) {
    throw new ConstructedTransactionMismatchError("transaction contains no instructions");
  }

  const tokenInstructions = instructions
    .map((ix, index) => ({ ix, index }))
    .filter(
      ({ ix }) =>
        ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID),
    );

  if (tokenInstructions.length === 0) {
    throw new ConstructedTransactionMismatchError(
      "transaction contains no SPL token instruction",
    );
  }

  // The token program is a seed of the ATA derivation, so it has to be settled
  // before any destination can be computed. Requiring one program across the
  // whole transaction is not a limitation — every transfer here moves the same
  // mint, and a mint lives under exactly one token program.
  const usesToken2022 = tokenInstructions[0].ix.programId.equals(TOKEN_2022_PROGRAM_ID);
  const tokenProgram = usesToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mixed = tokenInstructions.some(
    ({ ix }) => ix.programId.equals(TOKEN_2022_PROGRAM_ID) !== usesToken2022,
  );
  if (mixed) {
    throw new ConstructedTransactionMismatchError(
      "transaction mixes SPL Token and Token-2022 instructions; every transfer for one " +
        "mint must use that mint's own program",
    );
  }

  const expected = buildExpectedTransfers(intent, mint, tokenProgram);
  const actual = tokenInstructions.map(({ ix, index }) =>
    parseTransfer(ix, index),
  );

  // Greedy pairing. Each expected entry consumes one unmatched instruction, so
  // duplicate (destination, amount) pairs need one instruction each.
  const unmatched = [...actual];
  const missing: ExpectedTransfer[] = [];

  for (const want of expected) {
    const at = unmatched.findIndex(
      (got) => got.amount === want.amount && got.destination.equals(want.destinationAta),
    );
    if (at === -1) {
      missing.push(want);
      continue;
    }
    // A TransferChecked names the mint directly, so verify it rather than
    // relying on the ATA derivation to have caught a wrong one.
    const matched = unmatched[at];
    if (matched.isChecked && matched.mint && !matched.mint.equals(mint)) {
      throw new ConstructedTransactionMismatchError(
        `mint mismatch on ${want.label} — intent asset is ${mint.toBase58()}, ` +
          `transaction uses ${matched.mint.toBase58()}`,
      );
    }
    unmatched.splice(at, 1);
  }

  const describeMissing = (m: ExpectedTransfer) =>
    `${m.label} (${m.amount} to ${m.destinationAta.toBase58()})`;
  const describeExtra = (u: ActualTransfer) =>
    `instruction ${u.index} (${u.amount} to ${u.destination.toBase58()})`;

  // Both sides non-empty means value was *redirected* or *altered* rather than
  // simply added or dropped — a fee pointed at the wrong wallet, or an amount
  // edited. Reporting only the missing half would say "a transfer is absent"
  // while omitting that funds are going somewhere else instead, which is the
  // part worth waking up for.
  if (missing.length > 0 && unmatched.length > 0) {
    throw new ConstructedTransactionMismatchError(
      `transfers do not match the intent. Required but absent: ` +
        `${missing.map(describeMissing).join(", ")}. Present but undeclared: ` +
        `${unmatched.map(describeExtra).join(", ")}. ` +
        "Equal counts on both sides mean a destination or amount was changed, not merely " +
        "added or dropped.",
    );
  }

  if (missing.length > 0) {
    throw new ConstructedTransactionMismatchError(
      `the transaction is missing ${missing.length} transfer(s) the intent requires: ` +
        `${missing.map(describeMissing).join(", ")}. ` +
        "A dropped fee is as much a violation as an undeclared one — the user agreed to " +
        "every transfer in the intent, and settling only some of them is not the intent.",
    );
  }

  if (unmatched.length > 0) {
    throw new ConstructedTransactionMismatchError(
      `the transaction contains ${unmatched.length} transfer(s) the intent does not describe: ` +
        `${unmatched.map(describeExtra).join(", ")}. ` +
        "A constructed transaction must express only the signed intent.",
    );
  }
}

/**
 * Resolve every transfer the intent requires, primary first then fees in order.
 *
 * Fee order does not affect matching, which is set-based — but it is preserved
 * so a `fees[i]` label in an error points at the same index the signed payload
 * used.
 */
function buildExpectedTransfers(
  intent: PaymentIntentTerms,
  mint: PublicKey,
  tokenProgram: PublicKey,
): ExpectedTransfer[] {
  const resolve = (address: string, label: string): PublicKey => {
    try {
      return new PublicKey(address);
    } catch {
      throw new ConstructedTransactionMismatchError(
        `intent ${label} '${address}' is not a valid public key`,
      );
    }
  };

  const expected: ExpectedTransfer[] = [
    {
      label: "payment",
      amount: intent.amount,
      destinationAta: deriveAssociatedTokenAddress(
        resolve(intent.recipient, "recipient"),
        mint,
        tokenProgram,
      ),
    },
  ];

  (intent.fees ?? []).forEach((fee, i) => {
    if (fee.amount <= 0n) {
      throw new ConstructedTransactionMismatchError(
        `fees[${i}] amount must be positive, got ${fee.amount}`,
      );
    }
    expected.push({
      label: `fees[${i}]`,
      amount: fee.amount,
      destinationAta: deriveAssociatedTokenAddress(
        resolve(fee.destination, `fees[${i}].destination`),
        mint,
        tokenProgram,
      ),
    });
  });

  return expected;
}

/** Read one SPL token instruction into a comparable shape. */
function parseTransfer(ix: TransactionInstruction, index: number): ActualTransfer {
  if (ix.data.length === 0) {
    throw new ConstructedTransactionMismatchError(
      `token instruction ${index} has empty data`,
    );
  }

  const discriminator = ix.data[0];
  if (discriminator !== IX_TRANSFER && discriminator !== IX_TRANSFER_CHECKED) {
    throw new ConstructedTransactionMismatchError(
      `token instruction ${index} has discriminator ${discriminator}, which is neither ` +
        `Transfer (${IX_TRANSFER}) nor TransferChecked (${IX_TRANSFER_CHECKED}). ` +
        "Only transfers may appear against the token program here.",
    );
  }

  const isChecked = discriminator === IX_TRANSFER_CHECKED;
  const amount = readTransferAmount(ix.data);
  if (amount === null) {
    throw new ConstructedTransactionMismatchError(
      `token instruction ${index} is ${ix.data.length} bytes, too short to contain a u64 amount`,
    );
  }

  // Account layout:
  //   Transfer:        [source, destination, authority]
  //   TransferChecked: [source, mint, destination, authority]
  const minAccounts = isChecked ? 4 : 3;
  if (ix.keys.length < minAccounts) {
    throw new ConstructedTransactionMismatchError(
      `${isChecked ? "TransferChecked" : "Transfer"} at instruction ${index} needs at least ` +
        `${minAccounts} accounts, found ${ix.keys.length}`,
    );
  }

  return {
    index,
    amount,
    destination: ix.keys[isChecked ? 2 : 1].pubkey,
    mint: isChecked ? ix.keys[1].pubkey : null,
    isChecked,
  };
}
