# AFHO Market-Status Crank Bounty — Bot Guide

The crank-oracle program pays SOL to **anyone** who cranks the NYSE
market-status PDA across a session bell. This doc is everything a
third-party MEV bot needs to collect it.

## Program & PDAs

- Program: `ENJn9r8uCBLZXJ4unADAJfgNScWZuEm3rHD2LoBDpAki` (crank_oracle)
- `market_status` PDA: `findProgramAddress(["market_status"], program)`
- `market_calendar` PDA: `findProgramAddress(["market_calendar"], program)`
  — the schedule-as-data account (published NYSE hours, holidays, half
  days; see `scripts/launch/init-calendar.ts`)
- `bounty_config` PDA: `findProgramAddress(["bounty_config"], program)`
- `bounty_vault` PDA: `findProgramAddress(["bounty_vault"], program)` — SOL
  lamports paid out to crankers

## The race

`permissionless_crank` derives the expected session state from the
`market_calendar` PDA + the Solana clock — nobody signs anything, there is
no feed. It pays when ALL of these hold:

1. **A transition is due**: the calendar-derived state differs from the
   stored `market_status` state (a bell has passed).
2. **Fresh slot**: `clock.slot > bounty_config.last_crank_slot` — each crank
   consumes its slot; first-come-first-served on the bell.
3. **Funded vault**: the vault keeps a rent floor and errors `BountyExhausted`
   when empty — it can never be drained to zero.

The bounty pays **only when the market state actually changes**
(pre-market → open → after-hours → closed). A no-op crank is accepted and
consumes the slot but pays nothing. Burn rate is proportional to real NYSE
bells (~3 transitions per trading day: 04:00, 09:30, 16:00, 20:00 ET) —
nothing on weekends/holidays.

## Crank transaction

Accounts: `cranker` (any signer — you), `bounty_config`, `bounty_vault`,
`clock`, `market_status`, `market_calendar`, `halt_state`, `halt_pool_a?`,
`halt_pool_b?`, `system_program` (plus the two optional SOL/USDC pool vaults
when the pool is pinned — read them from `bounty_config`).

**While the regular session runs and halt pools are pinned** (see
`set-halt-pools`), every crank MUST also carry BOTH SPYx/USDC Raydium CLMM
pool accounts (errors 6015 otherwise). Nothing to push — the pools are live
market state; read their addresses from `bounty_config.halt_pool_a/b`. That's
the whole overhead — and it's what makes halts as live as the crank race
itself. A halt additionally needs the threshold breach on BOTH pools held
across two cranks ≥60s apart, so momentary wicks never count.

```ts
const crankIx = await crankProgram.methods
    .permissionlessCrank()
    .accountsStrict({
        cranker: botKeypair.publicKey,
        bountyConfig: bountyConfigPda,
        bountyVault: bountyVaultPda,
        clock: SYSVAR_CLOCK_PUBKEY,
        marketStatus: marketStatusPda,
        marketCalendar: marketCalendarPda,
        systemProgram: SystemProgram.programId,
    })
    .instruction();
```

No quote to push, no API keys, no oracle fees — the entire play is landing
the first crank transaction after a bell. `last_crank_slot` makes losers'
txs fail cleanly with `StaleQuote` (6005). The bell schedule is public
(NYSE calendar, mirrored in the on-chain `market_calendar` PDA); a TS
mirror of the evaluator lives at `scripts/lib/calendar.ts`.

Reference implementation: `scripts/keeper/mev-keeper-mainnet.ts` (the
protocol's own keeper competes in the same race).

## Economics

- Default bounty: **$0.75 per transition**, USD-denominated (set at
  `initialize_bounty`; adjustable on-chain via `set_bounty_usd`, authority
  only) and converted to lamports at the pinned SOL/USDC pool price.
- Burn ≈ 3 transitions × $0.75 ≈ **$2.25/trading day**, $0 on closed days.
  The vault is refilled by the protocol's own `bounty_top_up` flow; the
  keeper's `BOUNTY_RECYCLE` mode re-donates its winnings.
- Your costs: transaction fee + priority fee. Bid accordingly.

## What the bounty does NOT pay

Only `permissionless_crank` pays. The protocol's other instructions
(`make_offers`, `calc_completed_offers`, `update_tradeday_stats`,
`dex_buyback`, `buy_the_dip`, `distribute_staker_rewards`) pay nothing and
are gated to the protocol authority/keeper — those are run by the protocol's
own bot, which pays its own tx fees from its own keypair. No protocol vault
pays transaction fees.

## History

2026-09-19: Switchboard On-Demand (the previous oracle) wound down all
operations; the market-status source was replaced by the on-chain calendar.
The race mechanics (permissionless, first-crank-wins, transition-only pay)
are unchanged — entering is now strictly cheaper (no quote update ix, no
oracle fee).
