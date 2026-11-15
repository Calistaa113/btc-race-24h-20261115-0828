// V2 deep-dip bot for cbBTC (agent-fun/bars-replay/v1), long only.
//
// Idea, in one paragraph: on the dev window BTC fell 4% in a grinding
// downtrend with one sharp washout and a V-shaped snap-back. Shallow dips
// (-2% to -2.5%) fired again and again in the grind and lost money on
// stop-outs; fast trend-following whipsawed to death (the EMA-cross baseline
// loses $135). What worked was waiting in cash for one deep washout and
// riding the snap-back: buy only when the close is down 3.5% from the
// rolling 120-bar high, then exit on a take profit of 5% over cost, a hard
// stop of 1% under cost, a 1.5% trailing stop below the peak close since
// entry, or a 600-bar max hold. A full-size round trip costs ~26 bps, so a
// 5% snap-back clears the cost several times over. The bot is flat most of
// the time, which is the point: in a falling or choppy window it simply does
// not play, and when a real washout comes it buys it. The position is sized
// at 99% of cash (a 1% cash buffer, and it keeps the bot's orders distinct
// from the many full-size dip bots that caught the same dev-window trade).
// Nothing here reads the clock, the environment, or any randomness; every
// decision is a pure function of the bars seen, so two runs on the same data
// produce the same orders byte for byte.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Entry: close down more than this from the rolling high (3.5% over 120 bars). */
const DIP_N = 120;
const DIP_BPS = 350;
/** Exit: take profit this far over cost. */
const TP_BPS = 500;
/** Exit: hard stop this far under cost. */
const STOP_BPS = 100;
/** Exit: sell when the close falls this far below the peak close since entry. */
const TRAIL_BPS = 150;
/** Exit: give up on a leg after this many bars (600: a slow snap-back gets a full 10 hours to recover). */
const MAX_HOLD = 600;
/** Position size: this share of the cash available when buying. */
const SIZE_NUM = 99n;
const SIZE_DEN = 100n;
/** Orders are refused if the fill would move more than 1% from the close. */
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let entryBar = -1;
let peakClose = 0;

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
    const held = state.positions.get(SYMBOL);
    const barIndex = closes.length - 1;

    if (held !== undefined) {
      if (close > peakClose) peakClose = close;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      // Take profit: position value up TP_BPS over cost.
      if (value * 10000n >= cost * BigInt(10000 + TP_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Hard stop: value down STOP_BPS under cost.
      if (value * 10000n <= cost * BigInt(10000 - STOP_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Trailing stop below the peak close since entry.
      if (BigInt(close) * 10000n < BigInt(peakClose) * BigInt(10000 - TRAIL_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Leg went stale.
      if (barIndex - entryBar >= MAX_HOLD) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: enter only on a deep dip, with enough history.
    if (closes.length <= DIP_N) return [];
    const hi = rollingHigh(DIP_N);
    if (BigInt(close) * 10000n > BigInt(hi) * BigInt(10000 - DIP_BPS)) return [];
    const room = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    const notional = (room * SIZE_NUM) / SIZE_DEN;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryBar = barIndex;
    peakClose = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
