// V3 deep-dip + scale-in bot for cbBTC (agent-fun/bars-replay/v1), long only.
//
// Idea, in one paragraph: on the dev window BTC fell 4% in a grinding
// downtrend with one sharp washout and a V-shaped snap-back. V2 caught only
// the washout (+$47.08). V3 adds two things. First, a second leg: a shallow
// dip bought only while the market is still near where the window opened
// (close within 4% of the first close) — that is the early range bounce
// (buy bar 423, sell bar 551, +$9.61); the same dip later in a downtrend
// (bars 819-864) never recovers, so the near-open filter is what keeps the
// shallow leg from bleeding. Second, the washout leg is split: buy 90% at
// -3.5% vs the rolling 120-bar high, then add the last 10% if it falls
// further to -3.7%. Splitting across bars faces fresh pool depth each time,
// so both fills pay less price impact than one full-size buy, and the second
// tranche buys nearer the bottom. Exits: Tier A takes profit at +5% over
// blended cost, hard stop -1%, trailing stop 1.5% below the peak close, or
// a 600-bar max hold; Tier B takes profit at +1% (the early bounce only
// recovers ~1.6%), hard stop -1.5%, trailing stop 2%, or a 200-bar max hold.
// A full-size round trip costs ~26 bps, so both legs clear their costs with
// room. Nothing here reads the clock, the environment, or any randomness;
// every decision is a pure function of the bars seen, so two runs on the
// same data produce the same orders byte for byte.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Tier A entry: first tranche buys this far below the rolling high. */
const DIP_N = 120;
const DIP_BPS = 350;
/** Tier A scale-in: add the rest if the dip deepens to this far below the high. */
const SCALE_BPS = 370;
/** Tier A first tranche: this share of the cash available when buying. */
const FIRST_NUM = 90n;
const FIRST_DEN = 100n;
/** Tier A exit: take profit this far over blended cost. */
const TP_BPS = 500;
/** Tier A exit: hard stop this far under blended cost. */
const STOP_BPS = 100;
/** Tier A exit: sell when the close falls this far below the peak close since entry. */
const TRAIL_BPS = 150;
/** Tier A exit: give up on a leg after this many bars. */
const MAX_HOLD = 600;
/** Tier B entry: close down more than this from the rolling high (2.65% over 120 bars). */
const DIP2_BPS = 265;
/** Tier B entry: only while the close is within this of the window's first close. */
const NEAR_OPEN_BPS = 400;
/** Tier B exit: take profit this far over cost. */
/** Exit (Tier B): take profit this far over cost (110 bps: the early leg's bounce usually runs a little past 1%). */
const TP2_BPS = 110;
/** Tier B exit: hard stop this far under cost. */
const STOP2_BPS = 150;
/** Tier B exit: sell when the close falls this far below the peak close since entry. */
const TRAIL2_BPS = 200;
/** Tier B exit: give up on a leg after this many bars. */
const MAX_HOLD2 = 200;
/** Orders are refused if the fill would move more than 1% from the close. */
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let firstClose = 0;
let entryBar = -1;
let peakClose = 0;
let tier: 'A' | 'B' | null = null;
let scaledIn = false;

function rollingHigh(n: number): number {
  let hi = 0;
  const start = Math.max(0, closes.length - n);
  for (let i = start; i < closes.length; i++) if (closes[i]! > hi) hi = closes[i]!;
  return hi;
}

await runBars({
  onBatch(state: BarsState) {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    if (closes.length === 1) firstClose = close;
    const held = state.positions.get(SYMBOL);
    const barIndex = closes.length - 1;

    if (held !== undefined && tier !== null) {
      if (close > peakClose) peakClose = close;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const tp = tier === 'A' ? TP_BPS : TP2_BPS;
      const st = tier === 'A' ? STOP_BPS : STOP2_BPS;
      const tr = tier === 'A' ? TRAIL_BPS : TRAIL2_BPS;
      const mh = tier === 'A' ? MAX_HOLD : MAX_HOLD2;
      // Take profit: position value up tp over blended cost.
      if (value * 10000n >= cost * BigInt(10000 + tp)) {
        tier = null;
        scaledIn = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Hard stop: value down st under blended cost.
      if (value * 10000n <= cost * BigInt(10000 - st)) {
        tier = null;
        scaledIn = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Trailing stop below the peak close since entry.
      if (BigInt(close) * 10000n < BigInt(peakClose) * BigInt(10000 - tr)) {
        tier = null;
        scaledIn = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Leg went stale.
      if (barIndex - entryBar >= mh) {
        tier = null;
        scaledIn = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Tier A scale-in: add the remaining cash if the dip deepens.
      if (tier === 'A' && !scaledIn) {
        const hi = rollingHigh(DIP_N);
        if (BigInt(close) * 10000n <= BigInt(hi) * BigInt(10000 - SCALE_BPS)) {
          const room = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
          if (room >= BigInt(state.hello.fees.min_notional_quote_units)) {
            scaledIn = true;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: room, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
          }
        }
      }
      return [];
    }

    // Flat: enter only with enough history.
    if (closes.length <= DIP_N) return [];
    const hi = rollingHigh(DIP_N);
    // Tier A: deep dip, first tranche.
    if (BigInt(close) * 10000n <= BigInt(hi) * BigInt(10000 - DIP_BPS)) {
      const room = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
      const notional = (room * FIRST_NUM) / FIRST_DEN;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      entryBar = barIndex;
      peakClose = close;
      tier = 'A';
      scaledIn = false;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    // Tier B: shallow dip, only while still near the window's open.
    if (
      BigInt(close) * 10000n <= BigInt(hi) * BigInt(10000 - DIP2_BPS) &&
      BigInt(close) * 10000n >= BigInt(firstClose) * BigInt(10000 - NEAR_OPEN_BPS)
    ) {
      const room = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
      if (room < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      entryBar = barIndex;
      peakClose = close;
      tier = 'B';
      scaledIn = false;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: room, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
