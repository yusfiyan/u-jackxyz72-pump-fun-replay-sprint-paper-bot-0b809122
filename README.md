# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yusfiyan/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yusfiyan/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the Pump.fun Replay Sprint: it trades 10 SOL of paper money over a 24-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Two tiers, both deterministic — no clock, no randomness, no file writes; the bot only answers the harness batches on stdin/stdout.

- **Main tier — early crowd sniper.** Within one slot of a coin's creation, it buys when the first slot already shows a real crowd: at least 12 distinct buyers, buys beating sells in SOL, no sell by the creator, and the price no more than 3x its creation price. Stake is 0.2 SOL per coin, at most 4 main positions open at once. Exits: take profit at +25%, stop loss at −8%, a trailing stop that arms once a position is up 10% (sell after giving back 10% from the peak), and a 10-slot time limit.
- **Probe tier — guardrail scalps.** Tiny 0.02 SOL round trips on coins with fresh buy flow, paced by slot progress so the fills spread across the whole 24-hour window. Their job is the guardrail: at least 20 distinct coins traded with round trips of at least 0.01 SOL. They exit fast (+8% / −6% / 6 slots) so they cost little.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (hello, batch, done). Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kgxbmb08&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)</sub>
