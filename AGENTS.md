# AFHO (nyse-hours) — Agent Guide (MAINNET DEPLOYMENT TREE)

This is the sanitized deployment repo (fresh root 2026-10-15): all devnet-only
instructions, harnesses and test tooling were removed here and live ONLY in the
dev repo (consolidated-testy-token). Anything below that mentions devnet
tooling (`scripts/devnet/`, keeper --test-state, test_* instructions,
/gui harness, /demo) refers to that other tree. Rust unit/litesvm tests are
this repo's test gate; there is no ts-mocha suite here.

SPL token protocol tied to NYSE trading hours. Market status (closed / regular / extended / halted) is derived on-chain from a NYSE calendar PDA plus a SPYx circuit breaker; it drives staking incentives/penalties and an end-of-day "offer desk" that sells bonded token lots. Proceeds split 80% DEX buybacks / 10% stakers / 10% dip reserve.

## Market-state mapping (RESTORED 2026-09-26 — the original encoding)

The 2026-09-23 calendar transplant had flipped the byte mapping
(0=closed/1=regular/2=extended); restored project-wide to the ORIGINAL
encoding: **0=regular (open), 1=extended, 2=closed, 3=halted** (breaker-only).
`trading_day_index` rolls on the **(1|2)→0 transition — at the OPEN bell**
(`handlers.rs`).

- "open" (regular session) = 0; "night" (extended or closed) = 1 or 2;
  "halted" = 3.
- Day flow: 2 (closed overnight) → 1 (pre-market extended) → 0 (regular —
  the index rolls HERE at 9:30) → 1 (after-hours) → 2 (closed).
- Desk day-flow: `update_tradeday_stats` + `makeOffers` at the 16:00 close
  (0→1/0→2); `calcCompletedOffers` + `distributeStakerRewards` + the records
  snapshot at the 9:30 open (→0, where the index rolls).

## Layout

### `programs/amm` — offer desk

Instructions (`src/lib.rs`, 17 total):
- `make_offers` — builds the daily offer sheet via the 5-step sequential combinator (see "Combinator"). READ-ONLY over metrics; helpers in `instructions/helpers_make_offers.rs`.
- `make_alt_offers` / `alt_offer_claim` / `alt_offer_claim_sol` — the **alt desk**: fixed-terms second sheet, state 3 ONLY (see "Alt desk").
- `calc_completed_offers` — scores fill % at the open (state 0); runs the ratchet-floor decay.
- `offer_claim` / `offer_claim_sol` — bond claims; pricing logic lives in the private `quote_claim` helper in `offer_claim.rs` (NOT an instruction).
- `update_tradeday_stats` — end-of-day metric writes (fired before `make_offers`, at the 16:00 close).
- `dex_buyback` — slices the day's USDC vault into the pinned Raydium CPMM pool while market==open: raw `invoke_signed` `swap_base_input` (swap CPI isolated in `execute_swap`, Raydium CPMM ONLY); per-day hour-1 share target drawn 30–60% of budget (`first_hour_slice_weight_bps`), then 5%-of-remaining tail slices; NOT gated on fills; unspent budget rolls over in the vault; every fill ratchets `highest_buyback_basis`.
- `buy_the_dip` — always-on, ANY market state: spends the 10% USDC dip reserve when spot falls ≥3% below the mean of the self-sampled 32-slot spot ring (sampled every 75 slots; <5 samples = dark). Slice = 25% of reserve × (depth/10%)² × trend mult (recent-5 minus older-15 of `price_changes`, ×10 gain, clamped 0.25–1.25x); day cap 40% of day-start snapshot; fills ratchet the basis.
- `bounty_top_up` — permissionless two-hop AFHO→USDC→wSOL keeper-bounty refill, sized in bounty PAYMENTS: no-op while vault USDC value > 10 payments, else refill BY 10 payments. Reads `bounty_usd` from the crank's `BountyConfig` PDA (required `bountyConfig` account).
- `set_keeper`; `set_cpmm_pool` / `set_sol_usdc_pool` — **authority-only** (pool pinning routes every swap, so the keeper cannot re-pin). Every swap/pricing instruction hard-errors `PoolNotPinned` until pinned.
- `set_authority` — single-step handover (post-launch multisig path; `scripts/launch/rotate-authorities.ts` rotates all three programs).
- `load_test_data`, `load_offers`, `migrate_offer_list`, `reset_devnet_state` — **devnet-only, remove before mainnet** (comment-gated, not cfg-gated).

State (`state/offers_state.rs`): `AmmState` (ratchet floor, `keeper`, `cpmm_*` pool pins, `bb_*`/`dip_*` day budgets); `MarketMetrics` (20-day `price_changes` ring, 32-slot `spot_prices` ring, `trailing_stake_health[5]`, `available_supply` = minted − AMM's own AFHO vault); `AcceptedOffers` (3×[u8;5] fill %); `OfferList` + `lot_sizer` (tiers 0–22, top = 10M tokens; `Offer.remaining`/`total_offered` are **u32**; 104-byte zero-copy account).

Vault topology: `afho_vault`/`usdc_vault` are ATAs of amm_state; `usdc_dip`/`usdc_rewards` are PDA token accounts (`b"amm_usdc_dip"`/`b"amm_usdc_rewards"`, amm_state signs — NOT ATAs, they'd collide with `usdc_vault`).

Errors: one canonical `AmmError` enum in `error.rs` — positional codes **6000–6023** (6000 + declaration index), append-only, never reorder; 6000–6006 freeze what the first published IDL exposed.

### `programs/crank-oracle` — market status

- Market-status PDA (`b"market_status"`): status byte at offset 8, day index u64 at bytes 17..25. Mapping: **0=regular (open), 1=extended, 2=closed, 3=halted** (see migration warning). `initialize_state` writes `current_state = 99` — an intentional fail-closed sentinel; consumers guard `state <= 3`; do NOT clamp it.
- State source #1 — **calendar**: `market_calendar` PDA (`b"market_calendar"`, 615 bytes): session rules + holiday/half-day overrides + the ET tz/DST rule, evaluated against the clock (`calendar.rs::eval_state`). Session TIMES are FROZEN at init (no setter); the calendar authority (Squads multisig) owns only the mutable data — `set_holidays` (closures/half-days), `set_timezone` (tz/DST policy rule), and `set_halt_pools` (breaker venue re-pin) — each queued pending-until-next-bell (except `set_halt_pools`, which is immediate). `initialize_calendar`, `set_calendar_authority` (burn-address freeze path).
- State source #2 — **circuit breaker** (`halt.rs`): NYSE Rule 7.12 computed from TWO SPYx/USDC Raydium CLMM pools (`sqrt_price_x64`, no oracle signatures — the market IS the oracle). The venues are pinned in `BountyConfig` (the verified `HALT_POOL_*_MAINNET` pair by default at init); the CALENDAR AUTHORITY (Squads multisig) re-points them via `set_halt_pools` on a Raydium/xStocks rotation — a maintenance knob, never a halt override. 7%/13% before 15:25 ET → 15-min halt (L1/L2); 13% after 15:25 or 20% any time (L3) → close for the day. A halt needs the breach on BOTH pools held across two cranks ≥ `CONFIRM_WINDOW_SECS` (60s) apart (anti-wick); fail-open when no pools passed / stale. `halt_state` PDA (`b"halt_state"`, 41 bytes).
- `permissionless_crank`: per-slot replay guard (`slot > last_crank_slot`); evaluates calendar, applies breaker overlay, rolls the day index on (1|2)→0. The paid crank SHOULD carry both pool accounts during the regular session (the keeper always does on mainnet); absent pools leave the breaker inert (fail-open). `read_oracle_data` = calendar-only no-pay crank variant.
- `BountyConfig` = 229 bytes: `bounty_usd_raw` @48..56 (the amm reads this), `halt_pool_a` @165..197, `halt_pool_b` @197..229 (the breaker venues — default to the verified `HALT_POOL_*_MAINNET` pair, re-pointed by the CALENDAR AUTHORITY via `set_halt_pools`). A legacy 165-byte config migrates in place (authority-gated, rent delta from the payer, `last_crank_slot` preserved). `initialize_bounty` args: `bounty_amount, bounty_usd_raw, base_year, annual_inflation_bps, sol_usdc_pool, cpmm_program, usdc_mint`.
- Errors 6000–6019: 6000/6001/6004/6009–6011 are reserved dead Switchboard-era codes; 6012–6014 calendar; 6015–6019 halt layer.
- **Native `solana-program` build** — no anchor-lang in the binary. `src/idl_spec.rs` is the frozen anchor wire contract, compiled ONLY under the `idl-build` feature so `anchor build` regenerates `target/idl/crank_oracle.json` byte-identically — never re-add anchor-lang outside that gate; keep native constants in sync with the spec (the `idl_discriminators_match` litesvm test fails on drift).
- PDA creates must use `invoke_signed` with the PDA seeds — solana-system-interface marks `create_account`'s `to` as a signer meta (Agave 2.2+).
- Test-only (remove before mainnet): `test_set_state`, `test_set_trade_hours`, `test_set_halt_ref`, `test_collect_bounty`.

### `programs/staking`

Staking pool + bounty. Instructions: `initialize_pool`, `stake`, `claim` (market-open gate, state==0), `unstake`, `deposit_rewards`, `realize_penalties` (permissionless), `create_amm_position` / `deposit_rewards_from_amm` (AMM CPI entries — authenticate via the amm_state PDA signer + `seeds::program = pool.amm_program`), `set_authority`. Vault accounts in `stake`/`claim`/`unstake`/`deposit_rewards` are address-pinned to the pool's vaults. `posr_vault` is vestigial (created at init, never funded). 5% penalty legs route to the AMM bond vault.

### `scripts/` — deployment/ops TS

Organized by who runs them: `keeper/` (the daemons), `launch/` (launch sequence + pool/authority setup), `ops/` (authority knobs + inspection), `devnet/` (devnet-only tooling), `lib/` (shared helpers — never run directly).

- `scripts/keeper/` — `mev-keeper-mainnet.ts`, the deployed crank: permissionless calendar crank (carries both halt-pool accounts during the regular session), collects bounty, fires the AMM day-flow (`update_tradeday_stats` + `makeOffers` at the 16:00 close on night states 1|2; `calcCompletedOffers` + `distributeStakerRewards` at the 9:30 open — the day index rolls on the (1|2)→0 open bell, so start-of-day accounting runs on the fresh index; `makeAltOffers` on →3), `dexBuyback` slices while open, `buyTheDip` every loop (keeps the spot ring sampled). Also `record-day.ts` (dynamically imported by both keepers on the →0 OPEN transition), `twitter-announcer.ts` (the announcer: sheet post, flash sale, floor-decay digest, dip digest; see latching rules below), `MEV-BOUNTY.md`.
- `scripts/launch/` — the launch sequence: `prep.ts` → `launch.ts` (= `initialize.ts` + `init-calendar.ts` + `init-bounty.ts` → `amm-init.ts` → `check-authorities.ts` → `fund-launch.ts` → `launch-bundle.ts` → `setup-pools.ts` → `check-authorities.ts` → `burn-lp.ts`), plus `mint-create.ts`, `create-pool.ts` (MANUAL/RECOVERY only — the launch path creates the pool inside launch-bundle), `set-cpmm-pool.ts`/`set-sol-usdc-pool.ts`/`create-claim-alt.ts` (the `set-pools` one-shot legs), `withdraw-lp.ts`, `pool-init.ts`, `fund-bounty.ts`/`set-bounty-usd.ts`, `rotate-authorities.ts`. (The buyer repo is RETIRED 2026-09-29 — no `sync-buyer-config.ts`; `scripts/lib/jito.ts` carries the block-engine helpers the bundle needs.)
- `scripts/ops/` — authority knobs + inspection: `set-timezone.ts`, `set-halt-pools.ts`, `calendar-check.ts`, `spyx-layout.ts`, `raydium-pool-status.ts`.
- `scripts/lib/` — shared imports: `cluster.ts`, `cpmm.ts`, `deployment-state.ts` (deployment.json helpers), `calendar.ts`, `clmm.ts`, `tx.ts`, `keeper-log.ts`, `pdf.ts`, `nyse-holidays.json`.

### `sim/` — pure-stdlib Python simulation

Exact ports of the 3 metrics + combinator design space (`python3 sim/run.py --quiet`), `sim/dip.py` + `sim/run_dip.py` (buy-the-dip model), `sim/mc_sweep.py` (Monte Carlo sweep of the exact on-chain combinator).

### `app/` — Vite/React frontend

Routes: `/offer-desk` (the desk), `/dash` (dev dashboard), `/records`, `/oracle`, `/locking`, `/authority`, `/bond-desk`, `/litepaper`, `/disclaimer`. Reads `app/public/deployment.json`.

**Build gate:** any app change ENDS with a green `npm run build` in `app/` (`tsc -b && vite build`). Vite dev/HMR never typechecks, and several app types are hand-mirrored from the on-chain layout (e.g. `Position` in `hooks/stake/usePositions.ts`, the curve mirror in `lib/freezeCurve.ts`) — dev-server-green can still be build-broken (the 2026-10-02 freeze fields shipped exactly that way). `anchor run web-dist` = this build + a fresh zip of `dist/` contents → `app/dist/dep.zip` for upload (verifies `deployment.json` made it in); it is the LAST step of `anchor run launch` because the build copies `app/public/deployment.json` into the bundle.

Styling: `app/src/index.css` imports `app/src/styles/` — `tokens.css` (palette + `--fx-*` timing system), `fx-border.css`, `fx-shadow.css`, `fx-text.css` (incl. `GlitchText`), `glass.css`, `layout.css`, `components.css`; desk-specific wiring in `app/src/pages/AmmPage.css` (`--fx-desk-*`). Keyframes are sparse/intermittent by design — never constant blinking; `prefers-reduced-motion` strips them.

## Commands

- Build/check: `anchor build`; `cargo check -p amm` (fast iteration). Both run **warning-free** — `[workspace.lints.rust]` declares the macro-emitted cfgs (`anchor-debug`, `custom-heap`/`custom-panic`, `target_os = "solana"`) so `unexpected_cfgs` stays a real check. `cargo clippy -p amm -p staking -p crank-oracle` runs clean (one crate-level `too_many_arguments` allow in staking: `#[program]` signatures are the published IDL wire format).
- Tests: `anchor run test` / `anchor run test-staking` (registered in Anchor.toml), or directly:
  `ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/<file>.ts`
  - `tests/staking.test.ts` and `tests/trading-days.test.ts` need an external validator with all three programs (both self-fund from the local faucet). `trading-days` is a 12-day scripted day-flow harness driving the crank via `test_set_state` on the NEW state mapping; Raydium-pool legs self-skip on a bare localnet.
  - `tests/alt-sheet.test.ts` boots its own validator via `--require tests/alt-sheet-runtime.ts`; covers the alt desk (sizing/tier math, cooldown, state/caller gates, lazy alt_list init, `PoolNotPinned` fail-closed claim).
  - `load_test_data` knobs: metrics rings (incl. `spot_prices`/`spot_head`), fill %, `buyback_basis`, `untaken_days`, offer-sheet totals (**u32 counts** + tier terms).
- Ops (via `anchor run …`): `prep` (mint-create + buy-wallet funding sheet) → `launch` (= `init` → `amm-init` → `check-authorities` → `fund-launch` → `launch-bundle` → `set-pools` → `check-authorities` → `burn-lp` → `web-dist`) → `bount-mainnet` (keeper); `init` = `initialize.ts` + `init-calendar.ts` + `init-bounty.ts`. PDAs from earlier steps are inputs to later ones — order matters.
  - `amm-init` mints NOTHING; `fund-launch` is the ONE supply tx — 80% into `afho_vault` + 20% into the pool seed ATA (supply FINALIZED: 1B total, 20% → 200M, hardcoded) and revokes mint authority in the same tx (metadata authority was revoked at mint-create), so the authority wallet never holds supply (MAINNET_CHECKLIST §5).
  - `launch-bundle` is the ATOMIC launch step (Jito bundle on mainnet, sequential on devnet): create the CPMM from the seed ATA (AFHO leg FINALIZED at 200M; `USDC_TO_LP` is the ONE knob that sets launch price — CPMM pool PDAs can't be recreated deeper) → the buy wallet (`BUYER_WALLET_KEY`, FRESH, no prior stakes) swaps 0.18 × `USDC_TO_LP` USDC for ≥30M AFHO (3% of supply, finalized; min-out floor 30M) at the open price → stakes HALF as 3 × 5M lots (positions 0–2, staked days=0) and FREEZES them 21 trading days in the same tx (freeze legs are OPEN-session-only: run inside NYSE hours, clear of bell flips; preflight hard-fails otherwise; the freeze IS the lock, day-0 card reads full-bear off fresh metrics — disclosed in litepaper + checklist §4); the other ~15M stays LIQUID in the buy wallet. Hard balance preflights before anything is sent: launch wallet USDC ≥ `USDC_TO_LP`, buy wallet USDC ≥ 0.18 × `USDC_TO_LP` + SOL for fees/rents.
  - **`burn-lp` burns 100% of LP and EXECUTES by default** — `DRY_RUN=1` to preview.
  - `LAUNCH_AUTHORITY=<pubkey>` on `amm-init` initializes with a multisig vault PDA as authority (print-mode for Squads; set-pools/set_keeper/set-bounty-usd become multisig proposals).
  - **After every fresh `amm-init`, run `set-pools`** (one-shot: `set-cpmm-pool` + `set-sol-usdc-pool` + `create-claim-alt`) — pool pins live IN AmmState and a fresh state has none; every swap/pricing instruction hard-errors `PoolNotPinned` until they land. The three steps also exist standalone; `create-claim-alt` is a no-op unless a pin CHANGED an address (ALTs are append-only).
- Lint: `yarn lint` (prettier --check; fails repo-wide including at HEAD — informational only, don't reformat whole files).

## Conventions & invariants

### General

- **Devnet only.** `overflow-checks = true` in release — all metric math must widen before multiply. Release profile: `opt-level = "s"` workspace-wide with per-package `"z"` overrides for crank-oracle and staking.
- Units: price changes are centi-percent i16 (1% = 100); metric scores 0–10000 (stake health 0–100); `discount_bps` u8 is tenths of a percent (115 = 11.5%). **Floor units** (live price, ratchet floor, spot ring) = price per whole token × 1e9 (nano-USD) — `(usdc_raw × 1e12) / afho_raw` for the 6/9-dec pair, `(usdc_raw × 1e12) / lamports` for the SOL leg.

### Caller gates

- `authority || keeper`: `make_offers`, `calc_completed_offers`, `update_tradeday_stats`, `dex_buyback`, `buy_the_dip`, `distribute_staker_rewards`, `make_alt_offers`.
- Authority-only: `set_keeper`, `set_cpmm_pool`, `set_sol_usdc_pool`, `set_authority` (AMM + staking + crank-oracle).
- Keeper defaults to authority at init, rotate via `set_keeper`. Keeper-gated swap paths can only move vault funds through the pinned pool within the spot band + pacing caps.

### Metric-write separation

- `make_offers` is READ-ONLY over metrics (calculate + post sheet).
- End-of-day metric writes live in `update_tradeday_stats` (keeper fires it BEFORE `make_offers`, both at the 16:00 close, night states 1|2); start-of-day offer accounting (fill % rings) lives in `calc_completed_offers` (state 0, at the 9:30 open where the index rolls; the M2 guard wants the day-minus-one sheet — the sheet posted at yesterday's 16:00 close scores at this morning's open).
- Idempotency guards: `metrics.day_index` (stats), `offer_list.day_index` (sheet), `accepted_offers.day_index` (fills).

### Offer desk rules

- Never offer below `highest_buyback_basis` (ratchet floor, enforced at claim time); never offer more than 5% of vault per sheet; no offer sheet until ≥5 price samples (cold start = dark desk). Live price = pinned CPMM pool TWAP (vault-ratio fallback) in floor units.
- **Ratchet floor decay** (`calc_completed_offers`, fill-modulated, depth-accelerated): runs on every LOCKED trading day (live < floor) after a 5-locked-day grace; cut = 1% of the gap × depth factor (×1 at ≤10% gap up to ×7.41 at ≥64.1%) × demand keep (tier-weighted fill % — big×4/med×2/sml×1; a cleared sheet holds the floor; fills slow decay but never block it). `untaken_days` counts consecutive locked days, resets only on price recovery.
- **Closed-session boost:** sheets surviving into the boost state price +0.5% deeper (5 tenths, saturating) at claim time — a pure function of market state, the stored sheet is never mutated. The frontend mirrors it (`useAmmData` `tiersDisplay`); the announcer posts the flash-sale event with remaining lots. (Coded as the `state==2` branch.)
- **Announcer latching:** desk announcements (sheet post, flash sale) latch to ONE per calendar day (ET). Floor-decay digest (`floorDecayMessage`): posts old→new floor at a random minute inside 12:00–13:00 ET, once per ET day, only when the floor dropped below the last-announced baseline. Dip digest (`dipDigestMessage`): one per ET day (random minute in the 10:00–11:00 or 13:00–15:00 band), only when ≥1 slice fired.

### Alt desk

Fixed-terms second sheet (PDA `b"alt_offer_list"`, lazy `init_if_needed`), ONLY while market state is 3, at most ONE per trading day (`alt_list.day_index` cooldown).
- Sizing: exactly 5% of `afho_vault` (big 1% / med 1.5% / sml 2.5% + rounding; sml targets ~250 lots).
- Pricing AT CLAIM TIME: big −5% / med −4% / sml −3% off LIVE pool price — NO ratchet floor, NO above-spot gate, NO closed-session boost. Vesting fixed 7/4/3 days. NO fill/metric recording.
- Claims via `alt_offer_claim` / `alt_offer_claim_sol` require state==3 and today's sheet (80/10/10 splits, same staking CPI).
- ANY 3→(0|1|2) transition retires the sheet (dormant; revives on same-day re-halt). The keeper fires `make_alt_offers` on any →3; the announcer posts one oblique notification 5 min after the window opens if still open; the frontend shows `SpotlightBanner` on non-desk pages and the gold/amber `data-desk='lit'` state on the desk.

### Combinator (make_offers, sequential)

1. Totals ← momentum bump-taper. 2. Lot tiers ← vault abundance + excitement. 3. Counts derived (50/35/15 split ÷ lot sizes; **u32, no 255 clamp**). 4. Discount ← momentum bump, aggression-tightened, strictly big>med>sml. 5. Vesting ← stake health (clamped 3–25d; big caps at 25, sml/med saturate at 8/15), compensated for clamped discounts.

**Vault-scale tier shift:** the lot ladder window rides the vault's magnitude — t_hat = highest tier with lot ≤ vault/100 whole tokens, shift = t_hat − ceiling (floor 0). Ladder tops out at tier 22 (10M tokens): a full 1B-token vault places its 1% ceiling exactly at the top, so the shift clamp never engages at any reachable vault size. Bundles scale DOWN as the vault drains; nightly totals (momentum) drive COUNTS, not lot sizes. Constraints: sml tier < med < big (≥1 apart); discount strictly big > med > sml.

### Above-spot gate + late-nite bonus (claim time, `quote_claim` helper)

- `FloorHeldAtSpot` revert when a tier's effective price is ≥ live pool price — no discount, no sale. Rationale: a spot-priced vesting-locked bond is strictly dominated by the open market, and fills SLOW floor decay (demand keep). Partial-ratchet tiers stay buyable. The UI mirrors the gate ("Floor held — not below spot").
- Card price tone mirrors what's applied: green = full listed discount, blue = bonus is the live discount, green↔blue pulse = stacked, muted = ratchet partial (`priceDiscountTide` in `fx-text.css`).

### SOL payment leg (`offer_claim_sol`)

Bonds stay purchasable in SOL (internal vault flows are USDC-only):
- Lamports are solved from the pinned SOL/USDC pool's live vault balances (`cpmm_swap_input_for_out`, 25bps input-leg fee; `sol_price` is a fail-closed sanity read). Charge = spot + the trade's own price impact; the protocol always nets the full USDC cost. The desk mirrors the solve client-side (`lamportsForCostExact` in `app/src/hooks/amm/offerMath.ts`) and blocks the buy when order cost ≥ the pool's USDC vault (`InsufficientPoolLiquidity`).
- **Devnet drift gotcha:** the pinned SOL/USDC pool is small and the desk's own flows move it (`bounty_top_up` drains wSOL, SOL claims drain USDC), so its implied SOL price drifts unanchored within minutes. Re-anchor with `anchor run rebalance-sol-pool` (dry-run default, `EXECUTE=1`; `SOL_POOL_TARGET_USDC_PER_SOL` overrides the 200 default) — the real fix is a deeper pool (re-run `set-sol-usdc-pool` with bigger `SOL_USDC_SEED_SOL`/`SOL_USDC_SEED_USDC`) and re-pinning. Creator fee is disabled on the pinned config (`feeOn = 0`).

### SOL claim transaction (v0 + ALT; v1 path live)

- The legacy SOL claim tx is ~1213 bytes (19 under the packet limit) — no room for a compute-budget instruction, runs on the 200k CU default while consuming ~150–165k.
- `scripts/launch/create-claim-alt.ts` (or `anchor run set-pools`) creates/extends the claim lookup table (29 static accounts) → `claimLookupTable` in deployment.json; `useOfferClaim` sends v0 with `setComputeUnitLimit(400_000)` and falls back to the legacy form when the table is missing/incomplete. Re-run after a pool pin CHANGES an address (append-only table).
- **Priority fees** (estimate, never hardcode): `getPriorityFeeEstimate` (High) → recent-fees median fallback.

## Gotchas

- **OfferList resize after upgrade:** `Offer.remaining`/`total_offered` went u8 → u32 (account grew 80 → 104 bytes). A live pre-widening `offer_list` FAILS the exact-size zero-copy load in every instruction until resized — and the load runs before account constraints, so only `migrate_offer_list` (devnet-only, authority-gated, raw AccountInfo, idempotent) can heal it. After `anchor deploy`, run `anchor run amm-test-data` once (it migrates first). Fresh initializations allocate the new size directly.
- **Local tests need `ANCHOR_PROVIDER_URL`:** `[provider] cluster` in Anchor.toml is `devnet`, so `anchor test`'s `AnchorProvider.env()` resolves devnet and airdrops hit the devnet faucet. Run tests against the local validator explicitly (see Commands).
- Devnet: Jupiter won't index devnet mints — the desk reads the pinned CPMM pool instead.
- `dex_buyback`/`buy_the_dip` ratchet units: exec price = (input raw × 1e12) / AFHO raw, USDC-denominated.
- Stack budget: `initialize_amm` blew the SBF stack until the big accounts were boxed and `opt-level = "s"` was added — keep both. Always `anchor build` before running tests (stale .so masks fixes).
- **Floor-unit price resolution:** floor units are integer `price_per_token × 1e9` (nano-USD). All scale factors (`FLOOR_UNITS_PER_Q32` = 1e12, the vault-ratio ×1e12 numerator for 6/9-dec pools, claim cost divisor, min-out/exec-price numerators, SOL lamports) move together — keep them in sync if the scale ever changes. The TWAP conversion scales BEFORE dividing by dt/Q32 so sub-penny tokens keep precision.
- SOL/USDC pool pin must contain the AMM's OWN USDC mint: pinning a real-USDC pool silently breaks the frontend SOL price, `offer_claim_sol`, and `bounty_top_up`. Prefer `set-sol-usdc-pool`'s find-or-create path over hand-copying a pool address.
- Stale code comment: `offers_state.rs` still describes the spot ring as "usdc_raw × 1e6 / afho_raw" — actual scale is the ×1e9 floor units above.
- Keepers log measured ms/slot every ~5 min; ET sleep cadence is host-TZ-independent (Intl `America/New_York`).
- Root `tsc` shows pre-existing errors from `app/` — check script files individually.

## Before mainnet — removal list

DONE 2026-10-15 in this tree (see MAINNET_CHECKLIST §1): every item below was
removed here — amm `load_test_data`/`load_offers`/`reset_devnet_state`/
`migrate_offer_list`, crank `test_set_state`/`test_set_trade_hours`/
`test_set_halt_ref`/`test_collect_bounty`, all `scripts/devnet/` wrappers, the
devnet keeper + `--test-state` mode, and staking `update_amm_program`
(immutability confirmed: no AMM-replacement path on mainnet). The dev repo
retains all of it for devnet testing.

## Agent tooling

- **Jev MCP tools (`jev_server`):** cheap typed second opinions from a small model — use them INSTEAD of spending main-model tokens re-reading and deliberating. `jev_decide` (true/false), `jev_choose` (pick from labeled options), `jev_score` (ordinal grading). One judgment per call; fire independent calls in parallel.
- **Default to jev for these judgments** (don't burn main-model reasoning on them):
  - `jev_decide` before reverting or "fixing" any failing test/build error: is it pre-existing or caused by my change? Pass the error + the diff, not whole files.
  - `jev_decide` on any diff touching authority-gated/fund-moving paths, and on stale-comment or config-vs-invariant checks.
  - `jev_choose` for routing: which module/file owns a bug, which approach fits a constraint, which severity bucket an error belongs to.
  - `jev_score` to risk-grade a change before a big edit or deploy-adjacent step.
- **Limits:** jev judges only the text you pass it — it cannot read the codebase itself, and it is a strong hint, not proof, on security- or funds-relevant calls. Keep `state` to the minimal snippet; large pastes waste the savings.

## Launch posture (kev, 2026-10-01 — standing decision, do not re-raise)
All features are FINALIZED BEFORE mainnet deployment. Program upgrade authorities
are revoked AT deployment (`--final` cadence); there are no post-launch program
upgrades and no "ship it later via upgrade" planning. When a feature idea lands
post-freeze, the answer is "mainnet v2 program," not "reopen the authority."
Stop proposing renunciation-schedule alternatives on every task.
Key rotation (devnet relaunch practice): `tools/rotate-program-keys.sh` —
archives old keypairs, regenerates, and syncs every ID pin (incl. the native
crank `constants.rs` const that anchor never auto-syncs). The crank's
market_status/market_calendar/bounty_config PDAs are PROGRAM-scoped (no mint
in the seeds) — same program ID = same addresses = "already in use" on init;
a clean relaunch needs new program IDs, not just a new mint. After any
relaunch: deployment.json gets rewritten → svps + RESTART the announcer.

## Freeze (2026-10): voluntary lockup for a bonus rewards multiplier
`programs/staking` — one mechanic, three rules that must never drift:
- **Multiplicative only**: while `trading_day <= frozen_until_day` the position
  weight is `amount × base_multiplier(elapsed) × (10000 + freeze_bonus_bps)/10000`.
  NEVER a flat add — a flat add makes churn into fresh frozen positions pay.
- **Rate fixed at freeze**: `freeze(index, days)` prices the bonus once from
  (momentum, frozen share, days) and stores it. Momentum comes from the amm's
  `MarketMetrics.momentum_score` (account offset 360 — append-only cross-program
  contract), written daily by `update_tradeday_stats`. Curve params live on
  StakePool (init-time, hard cap 5000bps), mirror in `app/src/lib/freezeCurve.ts`
  and the FREEZE_PARAMS consts in amm-init/pool-init/tests — move together.
- **Grace sweep**: owner claim/unstake after the freeze ends pays the tail
  normally and clears; past `freeze_grace_days` (default 2) a permissionless
  `settle_freeze` sweeps the unclaimed tail back via an index bump (no token
  movement) and re-bases to base weight. A position with an uncleared freeze
  cannot re-freeze (claim first).
Gates: freeze is open-only + vested-positions-only (bond vesting excluded);
unstake blocked while frozen; no POSR-tax waiver. The popularity term is
DEMAND-PROVEN: frozen share above 30% of staked scales next-day bonuses DOWN.

