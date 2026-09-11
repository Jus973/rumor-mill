/**
 * abi.ts — generated from out/SealedAvailabilityMarket.sol/SealedAvailabilityMarket.json.
 * Regenerate with `npm run abi` after any contract change.
 */

export const SAM_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "_scheduler",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_attester",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_burnSink",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_feeRecipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_protocolFeeBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "_baseBond",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "_challengeWindow",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "_revealWindow",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "attest",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "reportHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "inactivePlayerIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "attester",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "balances",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "baseBond",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bondFor",
    "inputs": [
      {
        "name": "bucket",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Bucket"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bounties",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "buyer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "playerId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "revealFee",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "contingent",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "burnSink",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "challengeWindow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "claims",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "bountyId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "seller",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "commitHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "ciphertextHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "bond",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "escrow",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "committedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "priorTag",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.ReportTag"
      },
      {
        "name": "priorPractice",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Practice"
      },
      {
        "name": "bucket",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Bucket"
      },
      {
        "name": "claimed",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Outcome"
      },
      {
        "name": "state",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.ClaimState"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "createGame",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "lockTime",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deliverKey",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "encKeyForBuyer",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "encPubKeys",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeRecipient",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fillBounty",
    "inputs": [
      {
        "name": "bountyId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "commitHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "ciphertext",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "games",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "lockTime",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "attestedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "reportHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "voided",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "inactive",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isFinal",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextBountyId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextClaimId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "postBounty",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "playerId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "revealFee",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "contingent",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "outputs": [
      {
        "name": "bountyId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "priors",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "tag",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.ReportTag"
      },
      {
        "name": "practice",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Practice"
      },
      {
        "name": "updatedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "protocolFeeBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "purchase",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "refundUndelivered",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "registerEncPubKey",
    "inputs": [
      {
        "name": "compressedPubKey",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "reveal",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "claimed",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Outcome"
      },
      {
        "name": "bucket",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Bucket"
      },
      {
        "name": "evidence",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revealWindow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "scheduler",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setPrior",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "playerId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "tag",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.ReportTag"
      },
      {
        "name": "practice",
        "type": "uint8",
        "internalType": "enum SealedAvailabilityMarket.Practice"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPriorBatch",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "playerIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      },
      {
        "name": "tags",
        "type": "uint8[]",
        "internalType": "enum SealedAvailabilityMarket.ReportTag[]"
      },
      {
        "name": "practices",
        "type": "uint8[]",
        "internalType": "enum SealedAvailabilityMarket.Practice[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settle",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "slashUnrevealed",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "voidAttestation",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AttestationVoided",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Attested",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "reportHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "inactivePlayerIds",
        "type": "bytes32[]",
        "indexed": false,
        "internalType": "bytes32[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BountyPosted",
    "inputs": [
      {
        "name": "bountyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "gameId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "playerId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "revealFee",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "contingent",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimCommitted",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "bountyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "commitHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "bond",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "priorTag",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.ReportTag"
      },
      {
        "name": "priorPractice",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Practice"
      },
      {
        "name": "ciphertext",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimPurchased",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimRefunded",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "bond",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimRevealed",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "claimed",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Outcome"
      },
      {
        "name": "bucket",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Bucket"
      },
      {
        "name": "evidence",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimSettled",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "correct",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "actual",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Outcome"
      },
      {
        "name": "bucket",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Bucket"
      },
      {
        "name": "priorTag",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.ReportTag"
      },
      {
        "name": "priorPractice",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Practice"
      },
      {
        "name": "committedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "lockTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "bond",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "escrowReleased",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimSlashed",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "bond",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EncPubKeyRegistered",
    "inputs": [
      {
        "name": "who",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pubKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GameCreated",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "lockTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "KeyDelivered",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "encKey",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PriorSet",
    "inputs": [
      {
        "name": "gameId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "playerId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "tag",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.ReportTag"
      },
      {
        "name": "practice",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SealedAvailabilityMarket.Practice"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtocolFeeAccrued",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      {
        "name": "who",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyAttested",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadPubKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadState",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadValue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BondTooLow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ChallengeWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CommitMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EmptyCiphertext",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EvidenceTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GameExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LockNotReached",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LockPassed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoBounty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoClaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoGame",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPubKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAttested",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAttester",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotBuyer",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotFinal",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotScheduler",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSeller",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToWithdraw",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RevealWindowOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  }
] as const;
