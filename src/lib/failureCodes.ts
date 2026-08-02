export enum RelayerFailureStage {
  Validation = "Validation",
  SignatureCheck = "SignatureCheck",
  IntentMismatch = "IntentMismatch",
  CreditCheck = "CreditCheck",
  FeePayerCheck = "FeePayerCheck",
  BlockhashExpired = "BlockhashExpired",
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
