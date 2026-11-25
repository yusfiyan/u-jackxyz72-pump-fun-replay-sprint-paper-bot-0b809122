// Pump.fun Replay Sprint — paper bot strategy.
//
// Two tiers, both deterministic (no clock, no randomness; every decision is a pure
// function of the harness batches seen so far):
//
//   Main tier: snipe a coin within one slot of its creation when the first slot
//   already shows real crowd flow — at least 12 distinct buyers, buys beating
//   sells in SOL, no sell by the creator, and the price no more than 3x its
//   creation price. Stake 0.2 SOL per coin, at most 4 main positions open.
//   Exits: take profit +25%, stop loss -8%, a trailing stop once a position
//   is up 10% (sell if it gives back 10% from its peak), and a 10-slot limit.
//
//   Probe tier: tiny 0.02 SOL round trips on coins with fresh buy flow, paced
//   by slot progress so the fills spread across the whole 24h window instead
//   of bunching at the open. Their only job is the guardrail: at least 20
//   distinct coins traded with round trips of at least 0.01 SOL. They exit
//   fast (+8% / -6% / 6 slots) so they cost little.
//
// The harness caps open positions at 5, so the main tier's 4 leaves room for
// probes. Nothing is written to disk; the bot only answers batches.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ sizes

const SOL = LAMPORTS_PER_SOL;
const MAIN_SIZE = (SOL * 2n) / 10n; // 0.2 SOL per main coin
const PROBE_SIZE = SOL / 50n; // 0.02 SOL per probe round trip
const MIN_MAIN_CAP = SOL / 20n; // need at least 0.05 SOL of headroom to take a main slot
const SLIPPAGE_BPS = 500; // 5%: two slots of latency can move a fresh curve a lot

// ------------------------------------------------------------------ main tier

const MAIN_MIN_BUYERS = 12;
const MAIN_MAX_RUNUP = 3; // price at most 3x its creation price
const MAIN_MAX_OPEN = 4;
const MAIN_TAKE_PROFIT_BPS = 12_500; // +25%
const MAIN_STOP_LOSS_BPS = 9_200; // -8%
const MAIN_TRAIL_ARM_BPS = 11_000; // trailing stop arms once up 10%
const MAIN_TRAIL_GIVEBACK_BPS = 9_000; // sell after giving back 10% from the peak
const MAIN_MAX_HOLD_SLOTS = 10;

// ------------------------------------------------------------------ probe tier

const PROBE_MIN_BUYERS = 4;
const PROBE_MAX_RUNUP = 2;
const PROBE_MAX_OPEN = 2;
const PROBE_MAX_COINS = 30;
const PROBE_MAX_TRIPS_PER_COIN = 5;
const PROBE_TAKE_PROFIT_BPS = 10_800; // +8%
const PROBE_STOP_LOSS_BPS = 9_400; // -6%
const PROBE_MAX_HOLD_SLOTS = 6;
const PROBE_MIN_FRESH_BUYERS_THIS_BATCH = 2; // fresh flow this slot, else no (re-)entry
const PROBE_REBUY_COOLDOWN_SLOTS = 3;
const WINDOW_SLOTS = 403_213; // dev window span; the final window is 24h too
const PROBE_TARGET_BUYS = 92; // ~184 probe fills, plus main fills, across the window

// ------------------------------------------------------------------ types

type Tier = 'main' | 'probe';

interface Flow {
  createdSlot: number;
  creator: string;
  price0: number; // creation price, SOL per token (float ratio only)
  buyers: Set<string>;
  buySol: bigint;
  sellSol: bigint;
  creatorSold: boolean;
  batchBuyers: Set<string>; // distinct buyers in the current batch only
  lastSlot: number;
}

interface Meta {
  tier: Tier;
  entrySlot: number; // slot the buy was decided on
  peakBps: number; // best value/cost ratio seen, in bps (10000 = breakeven)
}

export interface StrategyStats {
  mainBuys: number;
  probeBuys: number;
  sells: number;
  probeCoins: number;
}

export class Strategy {
  #flows = new Map<string, Flow>();
  #meta = new Map<string, Meta>();
  #pendingBuy = new Map<string, { tier: Tier; decidedSlot: number }>();
  #probeTrips = new Map<string, number>();
  #probeLastSellSlot = new Map<string, number>();
  #firstSlot = -1;
  #probeBuys = 0;
  stats: StrategyStats = { mainBuys: 0, probeBuys: 0, sells: 0, probeCoins: 0 };

  // Fold this batch's events into the per-mint flow tables, then decide orders.
  decide(state: BotState, batch: Batch): OrderInput[] {
    if (this.#firstSlot < 0) this.#firstSlot = batch.slot;
    this.#ingest(batch);
    this.#syncPositions(state, batch.slot);
    const orders: OrderInput[] = [];
    orders.push(...this.#exits(state, batch.slot));
    orders.push(...this.#entries(state, batch));
    this.#prune(batch.slot);
    return orders;
  }

  // ------------------------------------------------------------ ingest

  #ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const price0 = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        this.#flows.set(e.mint, {
          createdSlot: e.slot,
          creator: e.creator,
          price0,
          buyers: new Set(),
          buySol: 0n,
          sellSol: 0n,
          creatorSold: false,
          batchBuyers: new Set(),
          lastSlot: e.slot,
        });
      } else if (e.event === 'TradeEvent') {
        const f = this.#flows.get(e.mint);
        if (f === undefined) continue;
        f.lastSlot = e.slot;
        if (e.is_buy) {
          f.buyers.add(e.user);
          f.batchBuyers.add(e.user);
          f.buySol += BigInt(e.sol_amount);
        } else {
          f.sellSol += BigInt(e.sol_amount);
          if (e.user === f.creator) f.creatorSold = true;
        }
      }
    }
  }

  // ------------------------------------------------------------ positions

  // Bring position metadata in line with the account: adopt filled buys,
  // drop positions that are gone (sold, completed, flattened).
  #syncPositions(state: BotState, slot: number): void {
    for (const mint of [...this.#meta.keys()]) {
      if (!state.positions.has(mint)) {
        this.#meta.delete(mint);
        this.#probeLastSellSlot.set(mint, slot);
      }
    }
    for (const mint of state.positions.keys()) {
      if (this.#meta.has(mint)) continue;
      const pb = this.#pendingBuy.get(mint);
      if (pb !== undefined) {
        this.#meta.set(mint, { tier: pb.tier, entrySlot: pb.decidedSlot, peakBps: 10_000 });
        this.#pendingBuy.delete(mint);
      } else {
        // A position with no recorded buy (should not happen): treat as main,
        // entered two slots ago, so the time limit still bounds it.
        this.#meta.set(mint, { tier: 'main', entrySlot: slot - 2, peakBps: 10_000 });
      }
    }
    // A recorded buy whose order is neither pending nor a position resolved
    // without a fill (rejected/failed): forget it so the mint can be tried again.
    for (const mint of [...this.#pendingBuy.keys()]) {
      if (state.positions.has(mint)) continue;
      const stillPending = [...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'buy');
      if (!stillPending) this.#pendingBuy.delete(mint);
    }
  }

  // ------------------------------------------------------------ exits

  #exits(state: BotState, slot: number): OrderInput[] {
    const orders: OrderInput[] = [];
    for (const [mint, holding] of state.positions) {
      const meta = this.#meta.get(mint);
      if (meta === undefined) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'sell')) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || curve.virtual_token_reserves === 0n) continue;
      const value = (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      if (holding.cost_lamports === 0n) continue;
      const ratioBps = Number((value * 10_000n) / holding.cost_lamports);
      if (ratioBps > meta.peakBps) meta.peakBps = ratioBps;
      const age = slot - meta.entrySlot;
      const tp = meta.tier === 'main' ? MAIN_TAKE_PROFIT_BPS : PROBE_TAKE_PROFIT_BPS;
      const sl = meta.tier === 'main' ? MAIN_STOP_LOSS_BPS : PROBE_STOP_LOSS_BPS;
      const maxHold = meta.tier === 'main' ? MAIN_MAX_HOLD_SLOTS : PROBE_MAX_HOLD_SLOTS;
      const trailing =
        meta.peakBps >= MAIN_TRAIL_ARM_BPS && ratioBps * 10_000 <= meta.peakBps * MAIN_TRAIL_GIVEBACK_BPS;
      const timeUp = age >= maxHold;
      if (ratioBps >= tp || ratioBps <= sl || trailing || timeUp) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        this.stats.sells++;
      }
    }
    return orders;
  }

  // ------------------------------------------------------------ entries

  #entries(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    for (const [mint, flow] of this.#flows) {
      if (orders.length >= 8) break; // stay well under the 16-order reply cap
      const age = batch.slot - flow.createdSlot;
      if (age < 0 || age > 30) continue;
      if (state.positions.has(mint)) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (flow.creatorSold) continue;
      if (curve.virtual_token_reserves === 0n || flow.price0 <= 0) continue;
      const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const runup = priceNow / flow.price0;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;

      // --- main tier: within one slot of creation, crowd already in.
      if (age <= 1 && this.#mainOpen() < MAIN_MAX_OPEN) {
        if (
          flow.buyers.size >= MAIN_MIN_BUYERS &&
          flow.buySol > flow.sellSol &&
          runup <= MAIN_MAX_RUNUP &&
          cap >= MIN_MAIN_CAP &&
          state.freeCashLamports() >= MAIN_SIZE + txFee
        ) {
          const size = MAIN_SIZE < cap ? MAIN_SIZE : cap;
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
          this.#pendingBuy.set(mint, { tier: 'main', decidedSlot: batch.slot });
          this.stats.mainBuys++;
          continue;
        }
      }

      // --- probe tier: fresh buy flow, paced across the window.
      if (this.#probeOpen() < PROBE_MAX_OPEN && state.committedPositionCount() < 5) {
        const trips = this.#probeTrips.get(mint) ?? 0;
        const isNewProbeCoin = trips === 0 && !this.#probeTrips.has(mint);
        if (isNewProbeCoin && this.#probeTrips.size >= PROBE_MAX_COINS) continue;
        if (trips >= PROBE_MAX_TRIPS_PER_COIN) continue;
        const lastSell = this.#probeLastSellSlot.get(mint);
        if (lastSell !== undefined && batch.slot - lastSell < PROBE_REBUY_COOLDOWN_SLOTS) continue;
        if (flow.batchBuyers.size < PROBE_MIN_FRESH_BUYERS_THIS_BATCH) continue;
        if (flow.buyers.size < PROBE_MIN_BUYERS) continue;
        if (flow.buySol <= flow.sellSol * 2n) continue;
        if (runup > PROBE_MAX_RUNUP) continue;
        if (cap < PROBE_SIZE) continue;
        if (this.#probeBuys >= this.#probeAllowance(batch.slot)) continue;
        if (state.freeCashLamports() < PROBE_SIZE + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: PROBE_SIZE, max_slippage_bps: SLIPPAGE_BPS });
        this.#pendingBuy.set(mint, { tier: 'probe', decidedSlot: batch.slot });
        this.#probeTrips.set(mint, trips + 1);
        this.#probeBuys++;
        this.stats.probeBuys++;
        this.stats.probeCoins = this.#probeTrips.size;
      }
    }
    return orders;
  }

  #probeAllowance(slot: number): number {
    if (this.#firstSlot < 0) return 1;
    const elapsed = slot - this.#firstSlot;
    const spread = Math.floor((elapsed / WINDOW_SLOTS) * PROBE_TARGET_BUYS);
    return 1 + spread;
  }

  #mainOpen(): number {
    let n = 0;
    for (const m of this.#meta.values()) if (m.tier === 'main') n++;
    for (const p of this.#pendingBuy.values()) if (p.tier === 'main') n++;
    return n;
  }

  #probeOpen(): number {
    let n = 0;
    for (const m of this.#meta.values()) if (m.tier === 'probe') n++;
    for (const p of this.#pendingBuy.values()) if (p.tier === 'probe') n++;
    return n;
  }

  // ------------------------------------------------------------ prune

  #prune(slot: number): void {
    for (const [mint, flow] of this.#flows) {
      if (slot - flow.createdSlot <= 40) continue;
      if (this.#meta.has(mint) || this.#pendingBuy.has(mint)) continue;
      this.#flows.delete(mint);
    }
    // batchBuyers only describes the batch just decided on.
    for (const flow of this.#flows.values()) flow.batchBuyers.clear();
  }
}
