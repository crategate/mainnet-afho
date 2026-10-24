# AFHO

A ticker that knows it's being watched.

AFHO ("After Hours") is a Solana token whose mechanics run on the NYSE clock. While Wall Street trades, the protocol buys its own token back from the market. After the bell, a nightly desk sells discounted AFHO bonds that land directly in locked staking positions. The size of the sheet, the discounts, even whether the desk opens at all get set by the token's own recent price and staking performance, read on-chain by the programs themselves.

Two ideas hold the design together. Two features do the work.

---

## Idea 1: the market clock lives on-chain

There is no oracle feed. A permissionless keeper cranks one state machine, and every program reads the same answer to "what session is it right now?"

- **An NYSE calendar account** stores the session times, the holiday schedule, half-day early closes, and the Eastern timezone and DST rules. The day rolls at the 9:30 open bell.
- **Halts are detected, not declared.** A circuit breaker mirrors NYSE Rule 7.12 by watching SPYx (a tokenized S&P 500 tracker) in two independent Raydium pools. A 7% or 13% drop means a 15 minute halt; 20% closes the market for the day. The drop must show on both pools across two separate checks, so one flash wick cannot fake a crash, and no signer anywhere can declare a halt by hand.

| State | When | What it means for you |
|---|---|---|
| OPEN | NYSE trading hours | Claims allowed, no exit penalties, buybacks run |
| AFTER-HOURS | mornings and evenings | Night desk open, 3% exit penalty on principal |
| CLOSED | nights and weekends | Night desk open with a 0.5% sweeter discount, 6% exit penalty |
| HALTED | circuit breaker tripped | Largest exit penalty (18%), alt desk takes over |

The same keeper that flips the state gets a small bounty (~$0.75 per real flip, inflation-adjusted, paid from protocol funds). Anyone can run the crank; it moves no vault funds.

## Idea 2: the protocol reacts to its own tape

Most tokens have features that ignore the price. AFHO's features read it, and the reading is mechanical rather than promotional:

- **The bond desk prices off its own pool.** The desk, the buyback engine, and the dip buyer all read and trade one venue, the protocol-owned Raydium pool, with TWAP pricing taken from that pool's own history. Nobody marks their own homework from a different book.
- **A ratchet floor from its own fills.** Every buyback raises the desk's pricing floor to the price the protocol itself just paid, and the desk will not sell below it. If the market falls to the floor, the desk goes dark rather than undercut its own buyers. The floor decays slowly when demand disappears, so a bear market re-opens the desk instead of bricking it.
- **Momentum is measured, not vibes.** Each trading day the protocol writes a momentum score from its own price history. That score sets the vesting range of the nightly bonds (3 to 25 trading days) and the entire freeze rate card below.
- **Demand proven, offers scaled.** The share of staked supply currently frozen is a live popularity gauge. Past a threshold, freeze bonuses scale down: the protocol pays less precisely when everyone already wants in.

## Feature 1: Lockup (staking and freeze)

Staking is where supply goes to sit. There is no emissions schedule and no time-based yield; rewards come only from bond proceeds, exit penalties, and claim taxes, distributed by weight.

- **Weight grows with commitment.** A trading-day multiplier ramps from 1.0x toward a 3.0x ceiling along a saturating curve (`base + days × (max − base) / (days + 60)`), so tenure pays with diminishing returns and day-one capital still counts.
- **Claims are market-open only**, with a 5% protocol tax that refills bond-sale inventory. Principal exits are free during the open session and penalized by state afterward (3% / 6% / 18%, fixed at initialization).
- **Freeze turns a stake into a term deposit.** Any vested position can freeze itself for a chosen number of trading days during the open session. The reward weight gets multiplied by a bonus that is fixed at freeze time from three inputs: the momentum regime, how much supply is already frozen, and the length of the commitment. Bear markets offer the richest bonuses and the longest allowed terms (up to +50% weight, capped); a crowded book offers less. Weight is base × (1 + bonus), always multiplicative, so a tenured frozen position always outweighs a fresh one and churn never pays.
- **The freeze is the lock.** Principal is locked until the freeze ends, and unclaimed frozen-period rewards must be collected within a short grace window (2 trading days) before a permissionless sweep returns them to the pool for everyone else.

## Feature 2: the bond desk

Every night after the close, the desk posts a fresh sheet of three bond tiers. Buyers pay USDC or SOL and receive AFHO at a discount, delivered straight into a vesting staking position; the tokens never sit liquid in the buyer's wallet. Every bond buyer is a staker from second one.

How the sheet gets built, and what keeps it honest:

- **Terms are set by the tape.** Sheet size (at most 5% of the vault per night), the tiered discounts, and the 3-to-25-day vesting range all come from the day's momentum and demand picture.
- **Two hard floors.** No tier prices below the buyback ratchet floor, and a tier within 0.5% of live refuses to sell: no real discount, no sale.
- **Proceeds split 80/10/10.** 80% becomes next-session buyback budget, 10% feeds staker rewards, 10% refills the dip reserve.
- **Buybacks are paced, not dumped.** One slice every 150 slots, pseudo-randomly sized, roughly half the budget front-loaded into the first hour, leftovers rolling over. Every executed slice ratchets the floor.
- **The dip reserve is always on.** 10% of proceeds funds a buyer that triggers when the pool falls 3%+ below its own 32-sample average, sizes quadratically with depth, throttles on a falling 20-day trend, and is capped at 40% of the reserve per day so one knife can't empty it.
- **When the market halts, an alt desk takes over.** State 3 opens a second, fixed-terms sheet for that session only; any recovery retires it immediately.

The desk is not designed to run forever, and doesn't pretend to be. It is the distribution model: 80% of supply started in the bond vault, and the desk's job is to hand it to committed buyers on honest terms.

---

## Launch posture

- **Supply**: 1,000,000,000 AFHO, SPL Token-2022. 20% seeded the Raydium CPMM pool, 80% funds the bond desk.
- **One atomic launch.** Pool creation, a 3% operator buy at the open price, and the operator's staked-and-frozen lots (21 trading days, at the launch-day rate card) all execute in a single bundled unit.
- **Trust trio**: mint authority revoked in the launch transaction, token metadata immutable, 100% of LP burned. Program upgrade authorities are renounced after launch; the remaining authority knobs (keeper rotation, holiday updates, pool re-pins) move to a multisig.
- **Operators hold no advantage**: the calendar's session times are frozen at init (holidays and timezone rules remain updatable, fail-safe only, via multisig), halts can only be detected, and the keeper cannot touch vault funds.

## This repo

The sanitized deployment tree for mainnet: the three Anchor programs (`amm` desk, `staking` pool, `crank-oracle` market clock), the wallet-connected React app, and the launch and ops scripts. Devnet tooling and test harnesses live in the development repo; this tree builds, deploys, and runs production.

```
programs/        amm (desk, buybacks, dip), staking (pool, freeze), crank-oracle (clock + breaker)
app/             React + Vite frontend
scripts/         launch chain, ops, keeper, announcer
tools/           key rotation, verification helpers
```

Deployment is one command (`anchor run deploy`): fresh launch/buyer/keeper wallets with recovery phrases confirmed on screen, funding transfers from the calling wallet with live balance bars, key rotation, the full rehearsed launch chain with per-step confirmation, then the keeper handoff. See `Anchor.toml` and `MAINNET_CHECKLIST.md` for the runbook.

Rust unit and litesvm tests run with `cargo test --workspace`.

## Reading more

The [litepaper](litepaper.md) covers the economics in full. `docs/AUTHORITY-PLAYBOOK.md` documents every key that exists and where it goes after launch. AFHO is experimental software; the token has no intrinsic value, and nothing here is an offer or investment advice. The full risk disclaimer ships with the site.
