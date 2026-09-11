/**
 * Generates the three agent wallets plus the buyer's ECIES encryption keypair into
 * .agent-keys.json (gitignored, mode 0600). Refuses to overwrite an existing file.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { generateEncKeyPair } from '../src/lib/crypto.js';
import { writeFileSync, existsSync } from 'node:fs';

const PATH = '.agent-keys.json';
if (existsSync(PATH)) {
  console.log(`${PATH} already exists — not overwriting.`);
  process.exit(0);
}

const roles = ['buyer', 'aggregator', 'forecaster'] as const;
const out: Record<string, Record<string, string>> = {};
for (const r of roles) {
  const pk = generatePrivateKey();
  out[r] = { privateKey: pk, address: privateKeyToAccount(pk).address };
}
const enc = generateEncKeyPair();
out.buyer.encPrivateKey = enc.privateKey;
out.buyer.encPublicKey = enc.publicKey;

writeFileSync(PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
console.log(`wrote ${PATH} (mode 0600, gitignored)\n`);
for (const r of roles) console.log(`  ${r.padEnd(12)} ${out[r].address}`);
console.log(`\nFund each address with ~0.05 Sepolia ETH before running the demo.`);
