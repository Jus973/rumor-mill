/**
 * main.ts — a read-only window onto the deployed market.
 *
 * The page holds no state of its own and signs nothing. It replays the contract's logs
 * with the SAME indexer and scorer the CLI agents use (../agents/src/lib), so a number
 * shown here and a number printed by `npm run demo` cannot drift apart.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';

import { indexMarket, type MarketState, type IndexedClaim } from '../../agents/src/lib/indexer.js';
import { rankedLedger, ensembleWeight } from '../../agents/src/lib/scoring.js';
import { Outcome, Bucket } from '../../agents/src/lib/enums.js';
import { CONTRACT_ADDRESS, DEPLOY_BLOCK } from '../../agents/src/lib/constants.js';

import { gameLabel, playerName, playerTeam } from './labels.js';
import { addrLink, addrUrl, ago, esc, eth, ethLabel, lead, pct, short, ts } from './format.js';
import './style.css';

/** Public Sepolia RPC. Override at build time with VITE_RPC_URL if it rate-limits. */
const RPC = import.meta.env.VITE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const REFRESH_MS = 30_000;

const client = createPublicClient({ chain: sepolia, transport: http(RPC) }) as PublicClient;
const app = document.querySelector<HTMLDivElement>('#app')!;

let state: MarketState | null = null;
let lastOk = 0;
let error: string | null = null;

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

type ClaimStatus = { label: string; cls: string };

function claimStatus(c: IndexedClaim): ClaimStatus {
  if (c.unwound) return { label: 'unwound', cls: 'idle' };
  if (c.slashed) return { label: 'slashed', cls: 'bad' };
  if (c.settled) return c.settled.correct ? { label: 'correct', cls: 'ok' } : { label: 'wrong', cls: 'bad' };
  if (c.revealed) return { label: 'revealed', cls: 'info' };
  return { label: 'sealed', cls: 'warn' };
}

const outcomeName = (o: Outcome) => (o === Outcome.ACTIVE ? 'ACTIVE' : o === Outcome.INACTIVE ? 'INACTIVE' : '—');
const BUCKET_LABEL: Record<Bucket, string> = {
  [Bucket.B55]: '50–60%',
  [Bucket.B68]: '60–75%',
  [Bucket.B83]: '75–90%',
  [Bucket.B95]: '90–100%',
};

function totals(s: MarketState) {
  let purchases = 0;
  let volume = 0n;
  let escrowed = 0n;
  for (const c of s.claims.values()) {
    for (const p of c.purchases.values()) {
      purchases++;
      volume += p.revealFee;
      escrowed += p.contingent;
    }
  }
  let burned = 0n;
  for (const l of s.ledger.values()) burned += l.bondBurned;
  let bonded = 0n;
  for (const c of s.claims.values()) bonded += c.bond;
  const attested = [...s.games.values()].filter((g) => g.attested).length;
  return { purchases, volume, escrowed, burned, bonded, attested };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function gameCell(id: `0x${string}`): string {
  const g = gameLabel(id);
  if (!g) return `<span class="mono faint">${id.slice(0, 10)}…</span>`;
  return `${esc(g.matchup)}<div class="faint">week ${g.week}</div>`;
}

function playerCell(id: `0x${string}`): string {
  const n = playerName(id);
  if (!n) return `<span class="mono faint">${id.slice(0, 10)}…</span>`;
  const team = playerTeam(id);
  return `<b>${esc(n)}</b>${team ? `<div class="faint">${esc(team)}</div>` : ''}`;
}

function hero(s: MarketState | null): string {
  const blk = s ? s.toBlock.toString() : '…';
  return `
  <header class="hero"><div class="wrap">
    <h1>NFL Fantasy Agent Rumor Mill</h1>
    <p class="tagline">
      A market where tip agents sell <strong>sealed, bonded claims</strong> about whether an NFL
      player will be on the official inactive list. Sellers are paid on outcome and burn a bond
      when they're wrong. Everything below is read live from the contract on Ethereum Sepolia —
      this page signs nothing and stores nothing.
    </p>
    <div class="badges">
      <span class="badge"><i class="dot live"></i> Ethereum Sepolia <b>11155111</b></span>
      <span class="badge">contract <a class="mono" href="${addrUrl(CONTRACT_ADDRESS)}" target="_blank" rel="noopener">${short(CONTRACT_ADDRESS, 10)}</a></span>
      <span class="badge">block <b>${blk}</b></span>
      <span class="badge">indexed from <b>${DEPLOY_BLOCK.toString()}</b></span>
      <span class="badge" id="freshness">${lastOk ? `updated ${ago(lastOk)}` : 'loading…'}</span>
    </div>
  </div></header>`;
}

const EXPLAIN = `
<section>
  <h2>What this market is</h2>
  <div class="explain">
    <div class="card">
      <h3>Sellers list</h3>
      <p>An aggregator or forecaster posts a sealed claim on one (game, player) at its own ask,
      with a bond scaled to its stated confidence. The claim is encrypted on-chain: nobody can
      read it before paying, and the seller must reveal after lock or be slashed.</p>
    </div>
    <div class="card">
      <h3>Buyers bid</h3>
      <p>A buyer posts a bounty — "intel on this player, up to this price." It escrows nothing
      and names no seller. The buyer's agent matches bounties against open listings and buys the
      ones it trusts, weighting each seller by their public reputation score.</p>
    </div>
    <div class="card">
      <h3>Truth settles it</h3>
      <p>At lineup lock the operator attests the official inactive list. Correct sellers earn
      their share of each buyer's contingent, scaled by how early they were and how much the
      claim disagreed with the public injury report. Wrong sellers burn the bond.</p>
    </div>
  </div>
</section>`;

const FLOW = `
<section>
  <h2>Lifecycle of one claim</h2>
  <p class="section-note">Every step is an on-chain transaction against the contract above.</p>
  <div class="flow">
    ${[
      ['01', 'List', 'Seller commits an encrypted claim + bond'],
      ['02', 'Bid', 'Buyer posts a bounty with a price ceiling'],
      ['03', 'Match', "Buyer's agent picks listings it trusts"],
      ['04', 'Buy', 'Buyer escrows revealFee + contingent'],
      ['05', 'Lock', 'Lineup lock — listings freeze'],
      ['06', 'Reveal', 'Seller delivers the key, or is slashed'],
      ['07', 'Settle', 'Operator attests; payouts and burns execute'],
    ]
      .map(([n, t, d]) => `<div class="step"><div class="n">${n}</div><div class="t">${t}</div><div class="d">${d}</div></div>`)
      .join('')}
  </div>
</section>`;

function statsSection(s: MarketState): string {
  const t = totals(s);
  const cards: Array<[string, string, string?, string?]> = [
    [String(s.games.size), 'games scheduled', `${t.attested} attested`],
    [String(s.claims.size), 'sealed listings', ethLabel(t.bonded) + ' bonded'],
    [String(s.bounties.size), 'buyer bounties'],
    [String(t.purchases), 'purchases', ethLabel(t.volume) + ' in fees'],
    [String(s.settledEvents.length), 'claims settled', undefined, 'good'],
    [eth(t.burned), 'ETH bond burned', `${s.penaltyEvents.length} penalty events`, 'burn'],
  ];
  return `
  <section>
    <h2>Market to date</h2>
    <p class="section-note">Every figure is folded from contract logs since block ${DEPLOY_BLOCK.toString()} — there is no database behind this page.</p>
    <div class="stats">
      ${cards
        .map(
          ([v, k, sub, cls]) =>
            `<div class="stat ${cls ?? ''}"><div class="v">${v}</div><div class="k">${k}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`,
        )
        .join('')}
    </div>
  </section>`;
}

function leaderboard(s: MarketState): string {
  const rows = rankedLedger(s.ledger);
  if (!rows.length) return '';
  const body = rows
    .map((l) => {
      const cls = l.score >= 0 ? 'pos' : 'neg';
      return `<tr>
        <td class="nowrap">${addrLink(l.seller as `0x${string}`, 8)}</td>
        <td class="num"><span class="score ${cls}">${l.score >= 0 ? '+' : ''}${l.score.toFixed(3)}</span></td>
        <td class="num">${ensembleWeight(l.score).toFixed(2)}×</td>
        <td class="num">${l.hits}/${l.n}<div class="bar"><i style="width:${Math.round(l.hitRate * 100)}%"></i></div></td>
        <td class="num">${pct(l.hitRate)}</td>
        <td class="num">${l.bondBurned > 0n ? `<span style="color:var(--burn)">${eth(l.bondBurned)}</span>` : '<span class="faint">0</span>'}</td>
      </tr>`;
    })
    .join('');
  return `
  <section>
    <h2>Seller reputation</h2>
    <p class="section-note">
      Score is a log-scoring rule over settled claims: credit grows with how far the claim moved
      from the public injury-report prior and how early it landed, and a miss costs
      <span class="mono">log(0.05)</span>. Buyers weight each seller's opinion by
      <span class="mono">1 + max(0, score)</span>.
    </p>
    <div class="tablewrap"><table>
      <thead><tr>
        <th>Seller</th><th class="num">Score</th><th class="num">Ensemble weight</th>
        <th class="num">Hits</th><th class="num">Hit rate</th><th class="num">Bond burned (ETH)</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

function listings(s: MarketState): string {
  const rows = [...s.claims.values()].sort((a, b) => b.claimId - a.claimId);
  const body = rows.length
    ? rows
        .map((c) => {
          const g = s.games.get(c.gameId);
          const st = claimStatus(c);
          const revealed = c.revealed
            ? `${outcomeName(c.revealed.claimed)} <span class="faint">${BUCKET_LABEL[c.revealed.bucket] ?? ''}</span>`
            : '<span class="faint">sealed</span>';
          const settled = c.settled
            ? `${outcomeName(c.settled.actual)} <span class="faint">${(c.settled.payoutBps / 100).toFixed(1)}% payout</span>`
            : '<span class="faint">—</span>';
          return `<tr>
            <td class="num mono">#${c.claimId}</td>
            <td>${playerCell(c.playerId)}</td>
            <td class="nowrap">${gameCell(c.gameId)}</td>
            <td class="nowrap">${addrLink(c.seller)}</td>
            <td class="num">${eth(c.askRevealFee)}<div class="faint">+${eth(c.askContingent)} cont.</div></td>
            <td class="num">${eth(c.bond)}</td>
            <td class="num nowrap">${g ? lead(c.committedAt, g.lockTime) : '<span class="faint">—</span>'}</td>
            <td class="num">${c.purchases.size}</td>
            <td>${revealed}</td>
            <td>${settled}</td>
            <td><span class="pill ${st.cls}">${st.label}</span></td>
          </tr>`;
        })
        .join('')
    : '';
  return `
  <section>
    <h2>Sealed listings</h2>
    <p class="section-note">One row per claim a seller has listed. "Sealed" means the ciphertext is
    on-chain but the key has not been delivered — the claim column stays blank until reveal.</p>
    <div class="tablewrap">${
      body
        ? `<table><thead><tr>
            <th class="num">ID</th><th>Player</th><th>Game</th><th>Seller</th>
            <th class="num">Ask (ETH)</th><th class="num">Bond</th><th class="num">Lead</th>
            <th class="num">Buyers</th><th>Claimed</th><th>Actual</th><th>Status</th>
          </tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty">No listings yet.</div>'
    }</div>
  </section>`;
}

function bounties(s: MarketState): string {
  const rows = [...s.bounties.values()].sort((a, b) => b.bountyId - a.bountyId);
  const body = rows
    .map((b) => {
      const st = b.cancelled
        ? '<span class="pill idle">cancelled</span>'
        : '<span class="pill info">open</span>';
      return `<tr>
        <td class="num mono">#${b.bountyId}</td>
        <td>${playerCell(b.playerId)}</td>
        <td class="nowrap">${gameCell(b.gameId)}</td>
        <td class="nowrap">${addrLink(b.buyer)}</td>
        <td class="num">${eth(b.maxRevealFee)}</td>
        <td class="num">${eth(b.maxContingent)}</td>
        <td>${st}</td>
      </tr>`;
    })
    .join('');
  return `
  <section>
    <h2>Buyer bounties</h2>
    <p class="section-note">Bids, not orders. A bounty escrows nothing and names no seller — it
    states a player and a price ceiling, and the buyer's agent decides which listings to take.</p>
    <div class="tablewrap">${
      body
        ? `<table><thead><tr>
            <th class="num">ID</th><th>Player</th><th>Game</th><th>Buyer</th>
            <th class="num">Max fee</th><th class="num">Max contingent</th><th>Status</th>
          </tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty">No bounties yet.</div>'
    }</div>
  </section>`;
}

function games(s: MarketState): string {
  const rows = [...s.games.values()].sort((a, b) => b.lockTime - a.lockTime);
  const now = Math.floor(Date.now() / 1000);
  const body = rows
    .map((g) => {
      const claims = [...s.claims.values()].filter((c) => c.gameId === g.gameId).length;
      const st = g.unwound
        ? '<span class="pill idle">unwound</span>'
        : g.voided
          ? '<span class="pill bad">voided</span>'
          : g.attested
            ? '<span class="pill ok">attested</span>'
            : g.lockTime <= now
              ? '<span class="pill warn">locked, awaiting attestation</span>'
              : '<span class="pill info">open</span>';
      const inactives = g.attested
        ? g.inactivePlayerIds.length
          ? g.inactivePlayerIds.map((p) => esc(playerName(p) ?? p.slice(0, 10) + '…')).join(', ')
          : '<span class="faint">none — all active</span>'
        : '<span class="faint">—</span>';
      return `<tr>
        <td class="nowrap">${gameCell(g.gameId)}</td>
        <td class="mono nowrap">${ts(g.lockTime)}</td>
        <td class="num">${claims}</td>
        <td>${inactives}</td>
        <td>${st}</td>
      </tr>`;
    })
    .join('');
  return `
  <section>
    <h2>Games</h2>
    <p class="section-note">The demo runs on a fixture slate with a compressed clock, so one
    matchup appears once per synthetic week. Real Week 1 games lock before a five-minute demo
    could ever settle them.</p>
    <div class="tablewrap">${
      body
        ? `<table><thead><tr>
            <th>Game</th><th>Lineup lock (UTC)</th><th class="num">Listings</th>
            <th>Official inactives</th><th>Status</th>
          </tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty">No games scheduled yet.</div>'
    }</div>
  </section>`;
}

const FOOTER = `
<footer>
  <span>Read-only. No wallet, no signing, no backend.</span>
  <a href="https://github.com/Jus973/rumor-mill" target="_blank" rel="noopener">Source</a>
  <a href="${addrUrl(CONTRACT_ADDRESS)}" target="_blank" rel="noopener">Etherscan</a>
  <a href="https://repo.sourcify.dev/11155111/${CONTRACT_ADDRESS}" target="_blank" rel="noopener">Verified source (Sourcify)</a>
</footer>`;

// ---------------------------------------------------------------------------
// Render + poll
// ---------------------------------------------------------------------------

function render(): void {
  if (!state) {
    app.innerHTML = `${hero(null)}<div class="wrap"><div class="msg ${error ? 'err' : ''}">${
      error ? `Could not reach Sepolia: ${esc(error)}` : 'Replaying contract logs…'
    }</div></div>`;
    return;
  }
  const s = state;
  app.innerHTML = `
    ${hero(s)}
    <div class="wrap">
      ${error ? `<div class="msg err">Refresh failed (${esc(error)}) — showing last good data.</div>` : ''}
      ${EXPLAIN}
      ${FLOW}
      ${statsSection(s)}
      ${leaderboard(s)}
      ${listings(s)}
      ${bounties(s)}
      ${games(s)}
      ${FOOTER}
    </div>`;
}

async function refresh(): Promise<void> {
  try {
    state = await indexMarket(client);
    lastOk = Math.floor(Date.now() / 1000);
    error = null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  render();
}

/** Keep the "updated Ns ago" badge honest between polls without re-rendering tables. */
setInterval(() => {
  const el = document.querySelector('#freshness');
  if (el && lastOk) el.textContent = `updated ${ago(lastOk)}`;
}, 1000);

render();
void refresh();
setInterval(() => void refresh(), REFRESH_MS);
