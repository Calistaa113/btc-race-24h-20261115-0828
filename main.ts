// Ignition momentum bot for cbBTC (agent-fun/bars-replay/v1), long only.
//
// Idea, in one paragraph: one-minute BTC returns are noise (autocorrelation ~0 at
// every lag on the dev window), so fast trend-following whipsaws itself to death —
// the EMA-cross baseline loses $135 on the dev window. What does work is waiting
// in cash for a genuine up-leg and riding it: buy only when the close is up more
// than 1% over the last 30 minutes (a ~1.4-sigma 30-minute move), then exit on a
// 0.7% trailing stop from the highest close since entry, a 90-bar max hold, or the
// fast EMA crossing back below the slow one (the trend is broken). A full-size
// round trip costs ~26 bps, so a 1% ignition clears the cost with room; the
// trailing stop caps any single losing trade near 1% of equity. The bot is flat
// most of the time, which is the point: in a falling or choppy window it simply
// does not play, and in a rising window it catches the legs. Nothing here reads
// the clock, the environment, or any randomness; every decision is a pure
// function of the bars seen, so two runs on the same data produce the same
// orders byte for byte.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Entry: close up more than this over the lookback (1% over 30 bars). */
const LOOKBACK = 30;
const IGNITION_NUM = 101n; // CBBTC close must exceed close[LOOKBACK] * 101/100
const IGNITION_DEN = 100n;
/** Exit: sell when the close falls this far below the peak close since entry. */
const TRAIL_NUM = 993n; // peak * 993/1000
const TRAIL_DEN = 1000n;
/** Exit: give up on a leg after this many bars. */
const MAX_HOLD = 90;
/** Exit: fast EMA below slow EMA means the up-leg is over. */
const EMA_FAST = 8;
const EMA_SLOW = 21;
/** Orders are refused if the fill would move more than 1% from the close. */
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let entryBar = -1;
let peakClose = 0;

function pushClose(c: number): void {
  closes.push(c);
  const kf = 2 / (EMA_FAST + 1);
  const ks = 2 / (EMA_SLOW + 1);
  emaFast = emaFast === null ? c : c * kf + emaFast * (1 - kf);
  emaSlow = emaSlow === null ? c : c * ks + emaSlow * (1 - ks);
}

await runBars({
  onBatch(state: BarsState) {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    pushClose(close);
    const held = state.positions.get(SYMBOL);
    const barIndex = closes.length - 1;

    if (held !== undefined) {
      if (close > peakClose) peakClose = close;
      // Trailing stop: close fell 0.7% below the peak since entry.
      if (BigInt(close) * TRAIL_DEN < BigInt(peakClose) * TRAIL_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Trend broken: fast EMA back below slow EMA.
      if (emaFast !== null && emaSlow !== null && emaFast < emaSlow) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Leg went stale.
      if (barIndex - entryBar >= MAX_HOLD) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: enter only on a 30-minute ignition, with enough history.
    if (closes.length <= LOOKBACK) return [];
    const ago = closes[barIndex - LOOKBACK]!;
    if (BigInt(close) * IGNITION_DEN <= BigInt(ago) * IGNITION_NUM) return [];
    const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryBar = barIndex;
    peakClose = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
