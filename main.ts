// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
//
// A deterministic paper-trading bot for the 24h pump.fun replay: it starts
// with 10 SOL of paper money and trades the bonding curves the harness
// replays, one reply per batch, through stdin/stdout only. It never reads
// the clock, the environment or any randomness, and it writes no files.
//
// Strategy (see strategy.ts): a main tier snipes coins within one slot of
// creation once at least 12 distinct buyers are in, buys beat sells, the
// creator has not dumped and the run-up is at most 3x — 0.2 SOL a coin,
// at most 4 open, exiting at +25% / -8% / a trailing stop / 10 slots —
// plus a probe tier of paced 0.02 SOL round trips that keeps the bot on
// at least 20 distinct coins for the guardrail.

import { runBot } from './vendor/makefun-bot.ts';
import { Strategy } from './strategy.ts';

const strategy = new Strategy();

await runBot({
  onBatch(state, batch) {
    return strategy.decide(state, batch);
  },
  onDone(state, done) {
    const cashSol = Number(state.account.cash_lamports) / 1e9;
    const pnlSol = cashSol - 10;
    console.error(
      `done: ${done.reason}; final cash ${cashSol.toFixed(4)} SOL ` +
        `(net PnL ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL); ` +
        `main buys ${strategy.stats.mainBuys}, probe buys ${strategy.stats.probeBuys}, ` +
        `sells ${strategy.stats.sells}, probe coins ${strategy.stats.probeCoins}`,
    );
  },
});
