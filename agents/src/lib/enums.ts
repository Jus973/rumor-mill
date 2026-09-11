/**
 * enums.ts — the on-chain enums, mirrored once.
 *
 * Ordering is part of the ABI: these integers are what `ClaimSettled` carries and what
 * `abi.encode` commits to. SealedAvailabilityMarket.sol is the source of truth.
 */

export enum ReportTag {
  NONE = 0,
  PROBABLE = 1,
  QUESTIONABLE = 2,
  DOUBTFUL = 3,
  OUT = 4,
}

export enum Practice {
  UNKNOWN = 0,
  FULL = 1,
  LIMITED = 2,
  DNP = 3,
}

export enum Outcome {
  UNRESOLVED = 0,
  ACTIVE = 1,
  INACTIVE = 2,
}

export enum Bucket {
  B55 = 0, // 50–60 %
  B68 = 1, // 60–75 %
  B83 = 2, // 75–90 %
  B95 = 3, // 90–100 %
}

export enum ClaimState {
  Listed = 0,
  Revealed = 1,
  SettledCorrect = 2,
  SettledWrong = 3,
  Slashed = 4,
  Unwound = 5,
}

export enum PurchaseState {
  None = 0,
  Paid = 1,
  KeyDelivered = 2,
  Refunded = 3,
  Resolved = 4,
}
