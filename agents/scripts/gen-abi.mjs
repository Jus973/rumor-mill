// Regenerates src/lib/abi.ts from the Foundry artifact.
import { readFileSync, writeFileSync } from 'node:fs';
const art = JSON.parse(
  readFileSync('../out/SealedAvailabilityMarket.sol/SealedAvailabilityMarket.json', 'utf8'),
);
writeFileSync(
  'src/lib/abi.ts',
  `/**\n * abi.ts — generated from out/SealedAvailabilityMarket.sol/SealedAvailabilityMarket.json.\n * Regenerate with \`npm run abi\` after any contract change.\n */\n\nexport const SAM_ABI = ${JSON.stringify(art.abi, null, 2)} as const;\n`,
);
console.log(`wrote src/lib/abi.ts — ${art.abi.length} entries`);
