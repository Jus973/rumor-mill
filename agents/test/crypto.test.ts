import { describe, it, expect } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  Outcome,
  Bucket,
  generateEncKeyPair,
  randomSalt,
  randomSymmetricKey,
  sealClaim,
  wrapKeyForBuyer,
  openClaim,
  computeCommitHash,
  encodeEvidence,
  aesGcmDecrypt,
  eciesEncrypt,
  eciesDecrypt,
  MAX_EVIDENCE_BYTES,
  type ClaimPayload,
} from '../src/lib/crypto.js';

const GAME = keccak256(toHex('NFL2026W1SFSEA'));
const PLAYER = keccak256(toHex('NFLSFcmc'));

function samplePayload(overrides: Partial<ClaimPayload> = {}): ClaimPayload {
  return {
    v: 2,
    gameId: GAME,
    playerId: PLAYER,
    claimed: Outcome.INACTIVE,
    bucket: Bucket.B83,
    evidence: [
      {
        source: 'local-beat',
        ts: 1757000000,
        text: 'CMC not spotted in the open portion of practice for a second day',
      },
    ],
    rationale: 'Two consecutive DNPs with a soft-tissue injury at day 9.',
    salt: randomSalt(),
    ...overrides,
  };
}

describe('claim seal — full lifecycle round trip', () => {
  it('seller seals, buyer pays, key is delivered, buyer decrypts and verifies', () => {
    const buyer = generateEncKeyPair();
    const payload = samplePayload();

    // t=fill: seller emits ciphertext + commitHash on-chain. K stays local.
    const sealed = sealClaim(payload);

    // t=purchase: buyer pays. t=deliverKey: seller wraps K to the buyer's pubkey.
    const encKey = wrapKeyForBuyer(buyer.publicKey, sealed.key);

    // Buyer unwraps, decrypts, and checks the plaintext against the on-chain commitment.
    const { payload: got, verified } = openClaim({
      buyerPrivKey: buyer.privateKey,
      encKey,
      ciphertext: sealed.ciphertext,
      commitHash: sealed.commitHash,
    });

    expect(verified).toBe(true);
    expect(got).toEqual(payload);
    expect(got.claimed).toBe(Outcome.INACTIVE);
    expect(got.bucket).toBe(Bucket.B83);
  });
});

describe('the paywall — why the seal is two-step', () => {
  it('ciphertext alone (public at fill time) does not reveal the claim', () => {
    const payload = samplePayload();
    const sealed = sealClaim(payload);

    // This is everything a non-paying observer has from the ClaimCommitted event.
    const plaintextGuess = new TextDecoder().decode(sealed.ciphertext);
    expect(plaintextGuess).not.toContain('INACTIVE');
    expect(plaintextGuess).not.toContain('local-beat');

    // And it cannot be opened without K.
    expect(() => aesGcmDecrypt(randomSymmetricKey(), sealed.ciphertext)).toThrow();
  });

  it('only the buyer who paid can unwrap K', () => {
    const payingBuyer = generateEncKeyPair();
    const freeloader = generateEncKeyPair();
    const sealed = sealClaim(samplePayload());

    const encKey = wrapKeyForBuyer(payingBuyer.publicKey, sealed.key);

    expect(() => eciesDecrypt(freeloader.privateKey, encKey)).toThrow();
    expect(eciesDecrypt(payingBuyer.privateKey, encKey)).toEqual(sealed.key);
  });

  it('a garbage key delivery fails loudly rather than yielding junk (LLD §3.6 residual hole)', () => {
    const buyer = generateEncKeyPair();
    const sealed = sealClaim(samplePayload());

    // Seller delivers a well-formed envelope containing the WRONG key.
    const garbage = wrapKeyForBuyer(buyer.publicKey, randomSymmetricKey());

    expect(() =>
      openClaim({
        buyerPrivKey: buyer.privateKey,
        encKey: garbage,
        ciphertext: sealed.ciphertext,
        commitHash: sealed.commitHash,
      }),
    ).toThrow();
  });
});

describe('commitment binding — seller cannot swap content after the fill', () => {
  const fields: Array<[string, Partial<ClaimPayload>]> = [
    ['claimed', { claimed: Outcome.ACTIVE }],
    ['bucket', { bucket: Bucket.B95 }],
    ['gameId', { gameId: keccak256(toHex('NFL2026W2SFSEA')) }],
    ['playerId', { playerId: keccak256(toHex('NFLSFdeebo')) }],
    ['salt', { salt: randomSalt() }],
    ['evidence', { evidence: [{ source: 'national', ts: 1757000001, text: 'different' }] }],
  ];

  for (const [name, override] of fields) {
    it(`changing ${name} breaks the commit hash`, () => {
      const original = samplePayload();
      const sealed = sealClaim(original);
      const tampered = { ...original, ...override };

      const rehashed = computeCommitHash({
        gameId: tampered.gameId,
        playerId: tampered.playerId,
        claimed: tampered.claimed,
        bucket: tampered.bucket,
        evidenceBytes: encodeEvidence(tampered.evidence),
        salt: tampered.salt,
      });

      expect(rehashed).not.toBe(sealed.commitHash);
    });
  }

  it('buyer detects a payload that does not match the on-chain commitment', () => {
    const buyer = generateEncKeyPair();
    const honest = sealClaim(samplePayload());
    const swapped = sealClaim(samplePayload({ claimed: Outcome.ACTIVE }));

    // Seller delivers the key for a DIFFERENT payload than the one committed on-chain.
    const { verified } = openClaim({
      buyerPrivKey: buyer.privateKey,
      encKey: wrapKeyForBuyer(buyer.publicKey, swapped.key),
      ciphertext: swapped.ciphertext,
      commitHash: honest.commitHash, // what the chain actually holds
    });

    expect(verified).toBe(false);
  });

  it('tampered ciphertext is rejected by the GCM tag', () => {
    const sealed = sealClaim(samplePayload());
    const corrupted = Uint8Array.from(sealed.ciphertext);
    corrupted[corrupted.length - 1] ^= 0xff;

    expect(() => aesGcmDecrypt(sealed.key, corrupted)).toThrow();
  });
});

describe('canonical encoding — seller and buyer must agree byte-for-byte', () => {
  it('evidence key order does not change the hash', () => {
    const a = encodeEvidence([{ source: 'beat', ts: 1, text: 'x' }]);
    const b = encodeEvidence([{ text: 'x', ts: 1, source: 'beat' } as never]);
    expect(a).toEqual(b);
  });

  it('commit hash is stable across reserializations', () => {
    const payload = samplePayload();
    const h1 = computeCommitHash({
      gameId: payload.gameId,
      playerId: payload.playerId,
      claimed: payload.claimed,
      bucket: payload.bucket,
      evidenceBytes: encodeEvidence(payload.evidence),
      salt: payload.salt,
    });
    const h2 = computeCommitHash({
      gameId: payload.gameId,
      playerId: payload.playerId,
      claimed: payload.claimed,
      bucket: payload.bucket,
      evidenceBytes: encodeEvidence(JSON.parse(JSON.stringify(payload.evidence))),
      salt: payload.salt,
    });
    expect(h1).toBe(h2);
  });

  it('matches the Solidity vector pinned in test/SAM.t.sol', () => {
    // test_CommitHashMatchesTypeScriptVector hashes this exact tuple on-chain.
    const evidenceBytes = encodeEvidence([
      { source: 'local-beat', ts: 1757000000, text: 'CMC absent, second straight day' },
    ]);
    const h = computeCommitHash({
      gameId: GAME,
      playerId: PLAYER,
      claimed: Outcome.INACTIVE,
      bucket: Bucket.B83,
      evidenceBytes,
      salt: '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    });
    expect(h).toBe('0x8d52a90768cbf26fa1da1f49c8438ba19159cbda2eb62df99d92048629d1155d');
  });

  it('rejects evidence larger than the on-chain cap', () => {
    const huge = samplePayload({
      evidence: [{ source: 'beat', ts: 1, text: 'x'.repeat(MAX_EVIDENCE_BYTES) }],
    });
    expect(() => sealClaim(huge)).toThrow(/exceeds on-chain max/);
  });
});

describe('ECIES primitive', () => {
  it('round-trips arbitrary bytes', () => {
    const kp = generateEncKeyPair();
    const msg = new TextEncoder().encode('the key is the product');
    expect(eciesDecrypt(kp.privateKey, eciesEncrypt(kp.publicKey, msg))).toEqual(msg);
  });

  it('produces a fresh ephemeral key per envelope', () => {
    const kp = generateEncKeyPair();
    const k = randomSymmetricKey();
    const e1 = wrapKeyForBuyer(kp.publicKey, k);
    const e2 = wrapKeyForBuyer(kp.publicKey, k);
    expect(e1).not.toEqual(e2); // no deterministic envelope reuse
    expect(eciesDecrypt(kp.privateKey, e1)).toEqual(eciesDecrypt(kp.privateKey, e2));
  });

  it('rejects a malformed recipient pubkey', () => {
    expect(() => eciesEncrypt('0xdeadbeef', new Uint8Array(32))).toThrow(/compressed bytes/);
  });
});
