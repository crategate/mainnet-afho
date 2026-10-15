# AFHO Mainnet Checklist

Open work only — resolved items live in git history (old versions of this file) and docs/.
This repo IS the sanitized mainnet deployment tree (fresh root commit 2026-10-15, split from
consolidated-testy-token main @ the freeze merge). The dev/devnet repo keeps all harnesses.

## 1. Hard blockers — devnet-only code must not ship in the mainnet build

DONE in this tree (2026-10-15, all verified by cargo test + anchor build + grep sweeps):

- [x] crank-oracle UNGATED test instructions deleted: `test_set_state`, `test_set_trade_hours`,
      `test_set_halt_ref`, `test_collect_bounty` — handlers, discriminators, dispatch arms,
      idl_spec shims + `RulesSpec` + `queue_rules`, and the devnet CLMM program-id allowance
      (constants + `is_clmm_program` + the pool-mixing check). litesvm suite 26/26 green incl.
      the shrunk 13-entry discriminator-match test.
- [x] amm devnet instructions deleted: `load_test_data`, `load_offers`, `reset_devnet_state`,
      `migrate_offer_list` (whole files + lib.rs stubs + mod.rs pairs) and the devnet CPMM
      allowlist arm in both pool-pin instructions.
- [x] staking `update_amm_program` deleted — CONFIRMED by kev 2026-10-15: contracts are
      immutable from launch; there is no AMM-replacement path on mainnet, so the re-pin
      instruction has no reason to exist. (The old "keep as maintenance knob" idea from
      AUTHORITY-PLAYBOOK is superseded by this decision.)
- [x] scripts/devnet/ + mev-keeper.ts (devnet twin) + all devnet/test anchor-run labels
      removed; mainnet runs `mev-keeper-mainnet.ts` only. tests/ (ts-mocha localnet suites)
      removed — Rust unit/litesvm tests remain the gate.
- [x] sim/, tools/ scratch, root scratch files, GUI test harness + screenshots, /demo +
      /logo-demo lab routes, DEVNET announcer watermark: stripped.

## 3. Launch-day runbook (order matters)

Condensed from the phased plan; full detail in AGENTS.md.

1. **Prep:** metadata JSON final → IPFS → hash into `mint-create.ts`; fund launch wallet
   (programs ~8.7 SOL rent until the v4.2 reduction + PDA/vault rent ~1–2 SOL + fees +
   `USDC_TO_LP` USDC) and buy wallet (`0.18 × USDC_TO_LP` USDC + ~0.03 SOL); paid Helius tier
   live; VPS keeper/announcer units running against mainnet RPC.
2. **Deploy + init:** deploy 3 programs — do NOT `--final` yet — then
   mint-create → init → amm-init; `check-authorities` before any supply moves.
3. **fund-launch → launch-bundle → set-pools → check-authorities → burn-lp** (the
   `anchor run launch` chain; burn is default-on, `SKIP_BURN=1` only for rehearsal).
   The bundle now FREEZES the staked half in-bundle — freeze is OPEN-session-only:
   launch inside NYSE hours, clear of bell-flip minutes (preflight hard-fails early).
4. **Phase 1 (calendar + keeper, desk dark):** breaker arms at init with the verified SPYx
   venue pair; let the bells run a full day; `cal-check` + `spyx-layout` read-backs.
5. **Phase 2 (desk live, announcer last):** one tiny claim per currency as own
   counterparty; announcer ON only at the real launch.
6. **Post-launch:** renounce the three program upgrade authorities (`solana program
   set-upgrade-authority … 111…1`); verify mint authority revoked + metadata immutable +
   LP burned (screener-facing trust trio); rotate the four authorities to the ops multisig
   vault (`rotate-authorities` per WHICH, or squads `rotate` IXs) — devnet rehearsal of this
   is done, mainnet order: `set-keeper` BEFORE rotating amm authority. Screener surfaces:
   Jupiter express verification (1000 JUP, `jupiter-vrfd` skill — kills the "unverified"
   warning in wallets/aggregators) + rugcheck listing; DexScreener Enhance when volume
   justifies it.

## 4. Open economics / product decisions

- [ ] Alt sheet: e2e claim (both currencies) during a Phase-0/1 drill + sign off the same-day
      halt-flap revival semantics.
- [ ] Holiday list horizon: `nyse-holidays.json` covers 2026–2028. NYSE publishes ~3 years
      ahead; refresh via multisig (`yarn squads run IX=holidays FILE=…`) BEFORE the file's
      last date passes — after that the calendar silently treats every weekday as a trading
      day. Calendar reminder in the ops runbook.

## 5. Runtime verifies still owed

- [ ] `bounty_top_up` full cycle on the current deployment (crank program rotated 10-01 —
      re-run a top-up cycle against the new ID to re-verify the pins).

- [ ] Keeper mid-evening restart self-heal (posts the missed sheet on next loop).
      (fixed 20k µL/CU already attached everywhere).

## 6. Frontend / ops residue

- [x] `/dash` posrVault tile removed (useDashData.ts fetch + tile + address row).
- [x] App RPC fallback follows deployment.json cluster (main.tsx); explorer links derive the
      cluster suffix from deployment.json (TxResultModal/Activity/OfferLists); MarketStatus
      error copy de-devnet-ized.
- [ ] deployment.json on this tree still carries the devnet-instance values — the launch
      chain overwrites it on deploy day (web-dist runs last); nothing to hand-edit.

## 7. Known-accepted residuals (watch list, not blockers)

- Spot self-reference when the TWAP ring is stale (>10min quiet): claim pricing falls back
  to the same pool's vault ratio it trades against. Bounded by the ratchet floor, above-spot
  gate, ≤5%-of-vault sheets and pool depth; re-check after the pool matures.

- Permissionless-crank bounty griefing: `read_oracle_data` can burn a bell transition unpaid.
  Costs the griefer a tx per bell (~4–8/day); accepted.

- Breaker fail-opens: missed close-bell capture or >5-day ref age (long holiday stretches)
  leaves the breaker inert for that day. Keeper cadence covers the normal case.
- `read_oracle_data` pending-calendar eager cranks can land as unpaid heartbeats (harmless).


