/**
 * crypto.ts — sealed-claim envelope for the Sealed Availability Market.
 *
 * Implements LLD §3.6. The seal is deliberately TWO-STEP:
 *
 *   listing       ciphertext = AES-256-GCM(K, payload)      emitted in ClaimListed (public)
 *   purchase      a buyer pays
 *   key delivery  encKey     = ECIES(buyerPubKey, K)        emitted in KeyDelivered, per buyer
 *
 * Encrypting the payload straight to a buyer's key at listing time would let that buyer
 * read it without paying — and there is no single buyer at listing time anyway. Withholding
 * K is what makes the claim *sold* rather than *published*. One K opens the listing for
 * every buyer; each buyer receives it wrapped to their own pubkey. The ciphertext is public
 * and pre-committed from the moment of the listing, so the seller cannot swap the content
 * after seeing who bought it.
 */

import { gcm } from '@noble/ciphers/aes';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  encodeAbiParameters,
  type Hex,
} from 'viem';

// ---------------------------------------------------------------------------
// Enums — declared once in enums.ts, re-exported here for convenience.
// ---------------------------------------------------------------------------

export { Outcome, Bucket, ReportTag, Practice, ClaimState, PurchaseState } from './enums.js';
import { Outcome, Bucket } from './enums.js';

export interface EvidenceItem {
  source: string;
  ts: number;
  text: string;
}

/** The plaintext that is sealed at listing and forced public at reveal. */
export interface ClaimPayload {
  v: 2;
  gameId: Hex;
  playerId: Hex;
  claimed: Outcome;
  bucket: Bucket;
  evidence: EvidenceItem[];
  rationale: string;
  salt: Hex;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NONCE_LEN = 12; // AES-GCM standard nonce
const KEY_LEN = 32; // AES-256
const COMPRESSED_PUBKEY_LEN = 33;
const ECIES_INFO = 'SAM-ECIES-v1';

/** LLD §3.5: `reveal` enforces `evidence.length <= 4096`. */
export const MAX_EVIDENCE_BYTES = 4096;

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** Buyer's long-lived encryption keypair; the pubkey goes on-chain via registerEncPubKey. */
export function generateEncKeyPair(): { privateKey: Hex; publicKey: Hex } {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, /* compressed */ true);
  return { privateKey: bytesToHex(privateKey), publicKey: bytesToHex(publicKey) };
}

/** Fresh per-claim symmetric key K. Never leaves the seller until the buyer pays. */
export function randomSymmetricKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LEN));
}

/** 32-byte commitment salt. */
export function randomSalt(): Hex {
  return bytesToHex(new Uint8Array(randomBytes(32)));
}

// ---------------------------------------------------------------------------
// AES-256-GCM  (nonce is prefixed to the ciphertext)
// ---------------------------------------------------------------------------

export function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_LEN) throw new Error(`AES key must be ${KEY_LEN} bytes`);
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  const sealed = gcm(key, nonce, aad).encrypt(plaintext);
  const out = new Uint8Array(NONCE_LEN + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_LEN);
  return out;
}

export function aesGcmDecrypt(
  key: Uint8Array,
  blob: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_LEN) throw new Error(`AES key must be ${KEY_LEN} bytes`);
  if (blob.length <= NONCE_LEN) throw new Error('ciphertext too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const sealed = blob.subarray(NONCE_LEN);
  // Throws on tag mismatch — wrong key, wrong AAD, or tampered ciphertext.
  return gcm(key, nonce, aad).decrypt(sealed);
}

// ---------------------------------------------------------------------------
// ECIES over secp256k1: ephemeral ECDH -> HKDF-SHA256 -> AES-256-GCM
// Wire format: ephPubCompressed(33) || nonce(12) || ciphertext+tag
// ---------------------------------------------------------------------------

function deriveEciesKey(sharedSecret: Uint8Array, ephPub: Uint8Array): Uint8Array {
  // Salt with the ephemeral pubkey so each envelope derives an independent key.
  return hkdf(sha256, sharedSecret, ephPub, ECIES_INFO, KEY_LEN);
}

export function eciesEncrypt(recipientPubKey: Hex, message: Uint8Array): Uint8Array {
  const pub = hexToBytes(recipientPubKey);
  if (pub.length !== COMPRESSED_PUBKEY_LEN) {
    throw new Error(`recipient pubkey must be ${COMPRESSED_PUBKEY_LEN} compressed bytes`);
  }
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, pub, true);
  const key = deriveEciesKey(shared, ephPub);

  // Bind the ephemeral pubkey as AAD so it cannot be swapped in transit.
  const body = aesGcmEncrypt(key, message, ephPub);
  const out = new Uint8Array(ephPub.length + body.length);
  out.set(ephPub, 0);
  out.set(body, ephPub.length);
  return out;
}

export function eciesDecrypt(recipientPrivKey: Hex, blob: Uint8Array): Uint8Array {
  if (blob.length <= COMPRESSED_PUBKEY_LEN + NONCE_LEN) {
    throw new Error('ECIES blob too short');
  }
  const ephPub = blob.subarray(0, COMPRESSED_PUBKEY_LEN);
  const body = blob.subarray(COMPRESSED_PUBKEY_LEN);
  const shared = secp256k1.getSharedSecret(hexToBytes(recipientPrivKey), ephPub, true);
  const key = deriveEciesKey(shared, ephPub);
  return aesGcmDecrypt(key, body, ephPub);
}

// ---------------------------------------------------------------------------
// Canonical encoding + commitment
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON with sorted object keys. The evidence bytes are hashed into the
 * commitment AND passed verbatim to `reveal`, so seller and buyer must serialize them
 * byte-identically or the on-chain hash check fails.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** The exact bytes handed to `reveal(..., bytes evidence, ...)`. */
export function encodeEvidence(evidence: EvidenceItem[]): Uint8Array {
  return new TextEncoder().encode(stableStringify(evidence));
}

export function encodePayload(payload: ClaimPayload): Uint8Array {
  return new TextEncoder().encode(stableStringify(payload));
}

export function decodePayload(bytes: Uint8Array): ClaimPayload {
  return JSON.parse(new TextDecoder().decode(bytes)) as ClaimPayload;
}

/**
 * commitHash = keccak256(abi.encode(gameId, playerId, claimed, bucket, keccak256(evidence), salt))
 * Mirrors the contract's check in `reveal` exactly.
 */
export function computeCommitHash(args: {
  gameId: Hex;
  playerId: Hex;
  claimed: Outcome;
  bucket: Bucket;
  evidenceBytes: Uint8Array;
  salt: Hex;
}): Hex {
  const evidenceHash = keccak256(args.evidenceBytes);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [args.gameId, args.playerId, args.claimed, args.bucket, evidenceHash, args.salt],
    ),
  );
}

// ---------------------------------------------------------------------------
// The three lifecycle operations
// ---------------------------------------------------------------------------

export interface SealedClaim {
  /** Withheld until the buyer pays. This is the thing being sold. */
  key: Uint8Array;
  /** Public from the moment of the listing; emitted in ClaimListed. */
  ciphertext: Uint8Array;
  /** Stored on-chain; binds the seller to this payload before lock. */
  commitHash: Hex;
  /** Passed verbatim to `reveal` after lock. */
  evidenceBytes: Uint8Array;
}

/** SELLER, at listClaim. Produces the public ciphertext and the withheld key K. */
export function sealClaim(payload: ClaimPayload): SealedClaim {
  const evidenceBytes = encodeEvidence(payload.evidence);
  if (evidenceBytes.length > MAX_EVIDENCE_BYTES) {
    throw new Error(
      `evidence is ${evidenceBytes.length} bytes, exceeds on-chain max ${MAX_EVIDENCE_BYTES}`,
    );
  }
  const key = randomSymmetricKey();
  const ciphertext = aesGcmEncrypt(key, encodePayload(payload));
  const commitHash = computeCommitHash({
    gameId: payload.gameId,
    playerId: payload.playerId,
    claimed: payload.claimed,
    bucket: payload.bucket,
    evidenceBytes,
    salt: payload.salt,
  });
  return { key, ciphertext, commitHash, evidenceBytes };
}

/** SELLER, at deliverKey — once per ClaimPurchased. Wraps K to that buyer's pubkey. */
export function wrapKeyForBuyer(buyerPubKey: Hex, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  return eciesEncrypt(buyerPubKey, key);
}

/**
 * BUYER, on KeyDelivered. Unwraps K, decrypts the ciphertext, and verifies the plaintext
 * against the on-chain commitHash — proving the seller committed to this exact claim
 * before lock, rather than tailoring it after seeing the purchase.
 */
export function openClaim(args: {
  buyerPrivKey: Hex;
  encKey: Uint8Array;
  ciphertext: Uint8Array;
  commitHash: Hex;
}): { payload: ClaimPayload; verified: boolean } {
  const key = eciesDecrypt(args.buyerPrivKey, args.encKey);
  const payload = decodePayload(aesGcmDecrypt(key, args.ciphertext));
  const recomputed = computeCommitHash({
    gameId: payload.gameId,
    playerId: payload.playerId,
    claimed: payload.claimed,
    bucket: payload.bucket,
    evidenceBytes: encodeEvidence(payload.evidence),
    salt: payload.salt,
  });
  return { payload, verified: recomputed.toLowerCase() === args.commitHash.toLowerCase() };
}
