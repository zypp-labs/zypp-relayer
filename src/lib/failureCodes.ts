export enum RelayerFailureStage {
  Validation = "Validation",
  SignatureCheck = "SignatureCheck",
  IntentMismatch = "IntentMismatch",
  CreditCheck = "CreditCheck",
  FeePayerCheck = "FeePayerCheck",
  BlockhashExpired = "BlockhashExpired",
  /**
   * The relayer built the transaction itself and it did not match the signed
   * intent. Distinct from `IntentMismatch`, which covers a *client-supplied*
   * transaction disagreeing with its declared intent — this stage means our own
   * construction logic produced the wrong instruction, which is a far more
   * serious class of bug and must be separable in the failure data.
   */
  OutboundVerification = "OutboundVerification",
  /**
   * A spend policy refused the transaction: per-intent amount ceiling, or a
   * fee-payer velocity circuit breaker. Not a defect — a deliberate stop.
   */
  PolicyCheck = "PolicyCheck",
  Broadcast = "Broadcast",
  Confirmation = "Confirmation",
}

export interface RelayerFailure {
  stage: RelayerFailureStage;
  code: string;
  message: string;
  retriable: boolean;
}

export function relayerFailure(stage: RelayerFailureStage, code: string, message: string, retriable = false): RelayerFailure {
  return { stage, code, message, retriable };
}
