# AFHO: Hedge Fund flavored Defi

The hours of Wall St have never applied to crypto. This protocol 
runs a feature driven response to the question of "what if?"

TradFi has failed on delivering new financial vehicles to retail investors.
Certain securities became more accessible, but only crypto has pioneered and delivered 
new investment formats.

The recent emergence of perps proves that crypto powered securities design has only just begun.

After Hours brings another speculative perspective and an experimental, ironic approach to demand & distribution.

## Carrot & Stick

AFHO is an SPL token with incentives & penalties driven by the NYSE market status: while Wall St
trades, the protocol buys its own token back from the market. When the bell
closes, a nightly "offer desk" sells discounted, vesting bond lots straight
into staking positions.

### A ticker that knows it's being watched
The bonds' size, discount rate, and vesting period are determined by the
performance of the token's staking and price.

The wrong price conditions close the offer desk completely.

## The market clock

The whole protocol runs off one on-chain state machine, updated by a
permissionless keeper. There is no external oracle feed — the program
answers "what session is it right now?" by itself:

- **The NYSE calendar lives on-chain.** Session times, the holiday
  schedule, and half-day early closes are stored in a calendar account,
  along with the Eastern timezone & DST rules. Any program can read the
  clock and know exactly where Wall St is in its day.
- **Halts are detected on-chain too.** A circuit breaker mirrors NYSE
  Rule 7.12 by watching SPYx (a tokenized S&P 500 tracker) in two
  independent Raydium pools: a 7% or 13% drop means a 15-minute halt
  (13% late in the day closes it early), and a 20% drop closes the
  market for the day. The drop must show on **both** pools across two
  separate checks, so one flash wick can't fake a crash.

| State | Meaning | What happens |
|---|---|---|
| OPEN | NYSE trading hours | Buybacks run. Stakers can claim. |
| AFTER-HOURS | early morning & evenings | Night desk opens. Unstaking penalizes principal |
| CLOSED | Overnight / weekends | Night desk stays open, bonus 0.5% discount. Larger unstake fee. |
| HALTED | rare trading halt | Largest unstake fee |

## Cadence of the Coin

- **At the bell (OPEN):** buybacks resume if last night's desk
  actually sold bonds. No sales, no buyback. The highest buyback price sets 
  the bond price floor. This ratcheting floor decays slowly during bear cycles. During this time, exiting locked positions carries no penalty.

- **All Day & Night:** the dip hunting feature watches the price. A real dip (3%+ below its own recent average) triggers automatic buying, dampening turbulence & refilling the vault for bond offers. 

- **After Hours & Closed:** the **night desk** posts a
  fresh sheet of bonds. AFHO at a discount, delivered directly into
  vesting staked positions. Exiting staked positions during these hours comes with fees.

- **Next Opening Bell:** 80% of last night's proceeds buy back AFHO from
  the open market, 10% goes to lockup rewards, & 10% refills the dip reserve.

## Bond Desk 

At the end of each trading day, the desk prices three tiers of lots 
from the day's price momentum and how committed stakers are:

- **Discounts are strictly tiered** and never price below the **buyback floor** — the highest price
  the protocol itself has paid during buybacks. If the market falls to the floor, the
  desk goes dark on its own rather than undercut its own buyers. A tier priced within
  0.5% of live also refuses to sell: no real discount, no sale.
- **Vesting length**: purchased AFHO lands straight in a staked position locked
  for **3 to 25 trading days**, so every bond buyer is also a staker from
  second one.
- **Vault Balance Percentage**: at most 5% of the vault is offered per sheet. This maximum offering market condition range was tuned to sustain the bond desk's lifespan.
  
The bond desk isn't fully sustainable, and isn't designed to be. Ultimately it  serves as the token's distribution model.
80% of minted supply started in the protocol's bond desk vault, 20% went into Raydium pool.

### Buybacks: 80% of every bond sale

Buybacks only run during trade hours and only after accepted bond offers.
The transactions get sliced out over the session rather than dumped at once:

- **Paced**: one slice every 150 slots, sized pseudo-randomly.
- **Front-loaded**: roughly half the day's budget lands in the first hour
- **Rolls over**: unspent budget stays in the vault for the next session.
- **Ratchets**: every executed buyback raises the desk's pricing floor, so
  the desk can never sell cheaper than the protocol itself paid.

## The dip reserve: 10%

Ten percent of bond proceeds fund an always-on dip sniper algo:

- Triggers when the pool price falls **3% or more** below the mean of its own
  last 32 samples (sampled every 75 slots).
- Sizes its buys **quadratically** with depth. A 10% dip buys far more than
  twice what a 5% dip buys, and throttles when the 20-day trend is falling.
- Capped at **40% of the dip reserve per day**, so a knife never empties the
  reserve in one afternoon.

## Lockup Rewards: 10%

Ten percent of every bond sale is converted to AFHO and distributed to
stakers. Rewards are split by **weight**, and weight grows with commitment:

- **Trading-day multiplier**: weight ramps from 1.0x toward a configured peak
  (approaching **3.0x**) along a saturating curve
- **Claims are market-open only** (the desk's reward pool only pays out while
  the market is live), with a **5% protocol tax** that refills bond-sale
  inventory
- **Vested bond positions** participate with full weight immediately and
  unlock after their vesting period.

## Fees, penalties & costs at a glance

- **Pool fee**: Raydium CPMM's 0.25% per swap, paid by bond buyers on the
  payment leg (SOL buyers pay +25 bps to cover the conversion).
- **Claim tax**: 5% of every reward claim
- **Unstake penalties** (principal, by market state):
  - OPEN: none
  - AFTER-HOURS: 3%
  - CLOSED: 6%
  - HALTED: 18%
- **Keeper bounty**: ~$0.75 per real state flip, +5%/yr for inflation, auto-funded by the
  treasury.
- All bps parameters are fixed at pool initialization and capped at 100%.

## Token & liquidity

- **Supply**: 1,000,000,000 AFHO, SPL **Token-2022**.
- **Trust posture**: mint authority revoked. token metadata immutable.
- **Liquidity**: protocol-owned Raydium CPMM pool. Pricing (TWAP) comes from
  the same pool the swaps execute against, so the desk, the dip buyer, and
  the buyback all read and trade one honest venue.
- **Launch Mint**: 20% of supply seeded to the pool, 80% to the bond desk. Fully revoked.
- **Launch buy-in**: the launch bundle also buys 3% of supply for the
  operator at the open price, in the same atomic unit as pool creation.
  Half of it (1.5% of supply) is staked and frozen for 21 trading days at
  the launch-day rate card.

{{charts}}

## Freeze — lockup classes

Any vested stake can **freeze** for a chosen number of trading days
(the offered range lengthens during bear cycles). 

The freeze locks the principal until it ends. This multiplies the reward weight by a fixed bonus.
The available freeze rates move with the ticker:
juiciest multipliers for the longest commitments in the gayest of bear conditions.
Claimed frozen-period rewards must be
collected within a short grace window after the freeze ends or forteit to the rewards pool.


## Roles

- **Authority**  sets the keeper, pins the pools, moves protocol funds.
- **Keeper**  a hot wallet running the daily crank bot: flips market state,
  posts the sheet, fires buyback/dip slices. Cannot re-pin pools or touch
  vault funds directly.
- **Bond buyers & stakers**  the protocol's participants 

## Tech stack

- **Programs (Rust, Anchor 0.31)**: `amm` (offer desk, buybacks, dip,
  claims), `staking` (pool, multipliers, rewards), `crank-oracle` (market
  status + keeper bounty).
- **DEX**: Raydium CPMM via raw `swap_base_input` CPI + a hand-written TWAP
  reader.
- **Market status**: fully on-chain — a NYSE calendar account (sessions,
  holidays, half-days, ET/DST) plus a SPYx circuit breaker reading two
  Raydium pools. No third-party oracle.
- **Frontend**: React + Vite, wallet-connected, with a dev dashboard.
## Risks & disclaimer (summary)

AFHO is experimental software in development. The token has no intrinsic
value and no guarantee of appreciation; staking, bonding, and buybacks do not
imply profit. Parameters described here are current defaults and may change
before launch. Trading crypto involves risk of total loss, and nothing here
is an offer, solicitation, or investment advice. See the full risk disclaimer
on the website for details.
