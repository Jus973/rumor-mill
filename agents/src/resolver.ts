/**
 * resolver.ts — the bonded attester (LLD §4.1).
 *
 * THE primary trust assumption (HLD): a single key decides what the official list said.
 * It is bounded here by the challenge-window timelock (`settle` cannot run until
 * `attestedAt + challengeWindow`) plus the owner's `voidAttestation` escape hatch.
 * v2 would make this a bonded multi-attester challenge game.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import type { Hex, PublicClient, WalletClient } from 'viem';
import { keccak256, toHex } from 'viem';
import { publicClient, resolverWallet, short } from './lib/chain.js';
import { send, sendBatch, read } from './lib/tx.js';
import { act, info } from './lib/log.js';
import {
  loadFixture,
  resolveFixture,
  inactiveListFor,
  type ResolvedFixture,
  type ResolvedGame,
} from './lib/fixtures.js';

export class Resolver {
  constructor(
    private pub: PublicClient,
    private wallet: WalletClient,
    public fixture: ResolvedFixture,
  ) {}

  get address() {
    return this.wallet.account!.address;
  }

  /** createGame for every fixture game. */
  async createGames() {
    const results = await sendBatch(
      this.pub,
      this.wallet,
      this.fixture.games.map((g) => ({
        functionName: 'createGame',
        args: [g.gameId, BigInt(g.lockTime)],
      })),
    );
    this.fixture.games.forEach((g, i) =>
      act('RESOLVER', `createGame ${g.label} lock=+${g.lockTime - this.fixture.t0}s`, results[i].hash),
    );
  }

  /** setPriorBatch per game — the public report snapshot sellers are scored against. */
  async setPriors() {
    const results = await sendBatch(
      this.pub,
      this.wallet,
      this.fixture.games.map((g) => ({
        functionName: 'setPriorBatch',
        args: [
          g.gameId,
          g.players.map((p) => p.playerId),
          g.players.map((p) => p.priorTag),
          g.players.map((p) => p.priorPractice),
        ],
      })),
    );
    this.fixture.games.forEach((g, i) =>
      act('RESOLVER', `setPriorBatch ${g.label} (${g.players.length} players)`, results[i].hash),
    );
  }

  /**
   * Attest the official inactive list. One attestation settles every claim on the game.
   * The snapshot JSON is written to out/attestations/<gameId>.json so anyone can rehash it
   * against the on-chain reportHash.
   */
  async attest(g: ResolvedGame) {
    const snapshot = {
      source: 'fixture:week1.json',
      season: this.fixture.season,
      week: this.fixture.week,
      game: g.label,
      gameId: g.gameId,
      lockTime: g.lockTime,
      attestedBy: this.address,
      inactive: g.players
        .filter((p) => inactiveListFor(g).includes(p.playerId))
        .map((p) => ({ name: p.name, team: p.team, slug: p.slug, playerId: p.playerId })),
      active: g.players
        .filter((p) => !inactiveListFor(g).includes(p.playerId))
        .map((p) => ({ name: p.name, team: p.team, slug: p.slug, playerId: p.playerId })),
    };
    const json = JSON.stringify(snapshot, null, 2);
    const reportHash = keccak256(toHex(json));

    mkdirSync('out/attestations', { recursive: true });
    const path = `out/attestations/${g.gameId}.json`;
    writeFileSync(path, json + '\n');

    const ids = inactiveListFor(g);
    const { hash } = await send(this.pub, this.wallet, {
      functionName: 'attest',
      args: [g.gameId, reportHash, ids],
    });
    act('RESOLVER', `attest ${g.label} inactive=[${snapshot.inactive.map((p) => p.slug).join(', ') || '—'}]`, hash);
    info(`snapshot → ${path}  reportHash=${reportHash.slice(0, 18)}…  (rehash to verify)`);
  }

  async attestAll() {
    for (const g of this.fixture.games) await this.attest(g);
  }

  async isFinal(gameId: Hex): Promise<boolean> {
    return read<boolean>(this.pub, 'isFinal', [gameId]);
  }
}

export function makeResolver(fixture: ResolvedFixture): Resolver {
  return new Resolver(publicClient(), resolverWallet(), fixture);
}

// CLI: set up the fixture games and priors.
if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Math.floor(Date.now() / 1000);
  const fixture = resolveFixture(loadFixture('fixtures/week1.json'), t0);
  const r = makeResolver(fixture);
  console.log(`resolver ${short(r.address)}`);
  await r.createGames();
  await r.setPriors();
}
