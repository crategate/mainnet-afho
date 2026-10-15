# AFHO Authority Playbook — launch state, transfers, and the endgame

Every key that can do anything in this protocol, who holds it when, and how it
moves. Written 2026-09-19 (Switchboard removal / calendar split). Companion to
`MAINNET_CHECKLIST.md` (§70 program authorities, §5 LP custody) and
`docs/ORACLE-MIGRATION-PLAN.md` (the calendar design).


FOUR authority fields — one holder at launch, ONE ops squad later (§2):

| Field | Gates | At launch | After rotation |
|---|---|---|---|
| `AmmState.authority` | pool pins (`set_cpmm_pool`/`set_sol_usdc_pool`), `set_keeper`, admin | launch wallet | ops squad |
| `StakePool.authority` | `deposit_rewards`, amm-program pointer | launch wallet | ops squad |
| `BountyConfig.authority` | `fund_bounty`, `set_bounty_usd`/`amount` | launch wallet | ops squad |
| `MarketCalendar.calendar_authority` | `set_holidays`, `set_timezone`, `set_halt_pools` | launch wallet | ops squad |

- **Keeper hot wallet** (VPS): fires the daily flow; NO admin power; rotated
  by `set-keeper` (amm authority — a proposal after rotation). Never multisig.
- **Nobody, permanently:** mint authority, metadata authority, LP (burned at
  launch) + the three program upgrade authorities (renounced at final deploy).
- **Everything else** (vaults, market status, offer sheets…) = program PDAs,
  no authority exists.

Rule of thumb — *"who signs X?"*: authority field → the squad (launch wallet
until rotated); keeper → the VPS wallet; burned/renounced → nobody.

## 1. The complete inventory

Nothing below is exhaustive-by-vibes — this is every authority that exists in
the deployed programs plus the token-level rights, with what each can do at
worst.

| # | Authority | Lives in | What it gates (worst case if abused) | Launch holder |
|---|---|---|---|---|
| 1 | `AmmState.authority` | amm, per-mint PDA | `set_keeper`, `set_cpmm_pool`, `set_sol_usdc_pool` + admin paths — the **Raydium pool re-pin** path (if Raydium rotates pool programs/addresses after the audit); value moves stay inside program rules. Both pool pins pass the pool ACCOUNT in and validate ownership on-chain (pool must be owned by a known Raydium cp-swap program — 6024 `InvalidPoolPin` otherwise) and emit a `PoolPinned` event, so a re-pin is structurally limited to real Raydium pools and loudly visible. | |
| 2 | `StakePool.authority` | staking, per-mint PDA | `deposit_rewards` (update_amm_program was removed 2026-10-15 — contracts immutable from launch, no AMM-replacement path) | 
| 3 | `BountyConfig.authority` | crank-oracle, global PDA | `fund_bounty`, `set_bounty_usd`, `set_bounty_amount`, `set_authority` (worst: bounty size → drains bounty vault over time; bounded by vault). Stores the breaker venue FIELDS, but the re-pin instruction is gated by the calendar authority (row 4). | |
| 4 | `MarketCalendar.calendar_authority` | crank-oracle, global PDA | The MUTABLE calendar data + breaker-venue maintenance: `set_holidays` (closures/half-days — fail-safe only, can never open a session), `set_timezone` (the ET offset/DST rule — for a permanent US DST policy change), and `set_halt_pools` (re-point the SPYx/USDC breaker venues — a Raydium/xStocks rotation knob; the venue ACCOUNTS are passed in and must be CLMM-owned — 6017/6020 otherwise; worst: point at a dead venue → disables DETECTION; see §3 for the fabricated-halt residual). Session TIMES are FROZEN at init (no setter). Calendar knobs queue as pending; `set_halt_pools` is immediate. | Squads multisig |
| 6 | amm keeper keypair | wallet (hot) | runs swap/buyback/dip/offer instructions; no admin power; `set_keeper`-rotatable | VPS |


| 7 | Program upgrade authority ×3 | deploy-side (amm, staking, crank-oracle) | replace program code entirely — the biggest key in the system | **renounced at launch** (see §4) |
| 8 | Mint authority | SPL token | mint supply — **revoked in the fund-launch tx** | nobody (burned) |
| 9 | Metadata authority | Metaplex | change name/symbol/URI — **revoked in mint-create** | nobody (burned) |
| 10 | LP tokens | token accounts | redeem both pool legs — **burned at real launch** (checklist §5; unburned only during rehearsal, where they stay in the launch wallet) | nobody (burned) |
| 11 | `bounty_vault` / amm & staking vaults | program PDAs | no authority — only program instructions move them | n/a |
| 12 | Off-chain: X/TG announcer creds, RPC keys, the buy wallet (BUYER_WALLET_KEY) | 's infra | announcements + the launch-bundle 3% buy | |

tt-hook is not part of the deployed protocol (no live authority). The
`q`/tooling dirs hold no keys.

**That's all of them.** There is no oracle signer, no admin status override,
no upgrade path for market status — status is always derived from
`market_calendar` + Solana's clock.

## 2. The plan (2026-09-19)

**Launch (Phase 0/1):** (the launch wallet, `la.json`) holds #1–#6.
Program upgrade authorities are renounced at the final deploy. #8–#10 are
burned/revoked by the launch transactions themselves. This is the state
`anchor run launch` + `check-authorities` enforces.

**Community arrives (Phase 2):** ONE ops multisig (decided 2026-09-27 — keep
it simple, fewer keys and addresses to track):

- **Ops multisig (pragmatic, 2-of-3):** #1 amm, #2 staking, #3 crank bounty,
  **#4 calendar** — all four authorities rotate onto the SAME Squads vault
  PDA. All operational; nothing here can steal funds outright (the pool pins
  are additionally ownership-validated on-chain, rows 1+4). The calendar key
  CAN open sessions off-schedule (bounded by next-bell activation +
  visibility) — that is the strongest power in the bundle, which is exactly
  why it goes to a multisig rather than any single community member.

- **There is no treasury tier.** LP is fully burned at launch (§5 decision:
  burn-all) and no protocol authority can move vault funds outside program
  rules — so no custody multisig needs to exist. Fewer keys, fewer stories.
- **DECIDED (2026-09-27): AFHO does NOT adopt the new Arca/NYSE extended
  hours.** Session times stay the classic 9:30–16:00 ET bells, frozen at
  init (no setter exists — see §3). Only the HOLIDAY list gets its annual
  refresh (below); nothing about the hours ever changes.

## 3. The calendar authority in detail

The `market_calendar` PDA (615 bytes) holds ONE authority over the MUTABLE
calendar data only:

- `set_holidays` — holiday closures + half-days (fail-safe-only data).
- `set_timezone` — the ET offset/DST rule (for a permanent US DST policy
  change; the annual spring/fall recurrence is computed per year by the
  evaluator and needs no update).
- Session TIMES (the trade hours) are FROZEN at init — there is NO setter.
- Both setters queue into the SAME pending block and activate at the next
  observed bell — nothing flips mid-session; each knob may re-queue
  independently (6013 only blocks the same knob twice).
- Rules can only declare states 1/2; holidays can only close/shorten. State
  3 (halted) is reachable ONLY through the Rule 7.12 circuit breaker — no
  authority anywhere can declare a halt.

**Halts (venue maintenance only):** `permissionless_crank` overlays NYSE Rule
7.12 computed from two SPYx/USDC Raydium CLMM pools — the on-chain
tokenized S&P (see `halt.rs`): −7%/−13% before
15:25 ET → 15-minute halt; −13% after 15:25 and −20% anytime → closed for
the day. Halt DETECTION is fully automatic (pool mechanics only). The venue
ADDRESS pair lives in `BountyConfig` (defaults to the verified
`HALT_POOL_*_MAINNET` pair at init); the calendar authority — the SAME Squads
multisig (row 4) — may re-point it via `set_halt_pools` if Raydium/xStocks
rotates the pools. Since 2026-09-27 that pin is ownership-validated on-chain:
the venue ACCOUNTS are passed in and must be owned by a Raydium CLMM program
(arbitrary pubkeys / non-CLMM programs are refused at pin time). Through
genuine venues that knob can never trigger or extend a halt, and it cannot
fabricate one. **Residual (accepted, disclosed):** pool creation is
permissionless, so a calendar authority COULD pin attacker-created CLMM
venues and synthesize a close-for-day — a grief, not a theft (halts move no
funds); bounded by the 2-of-3 multisig + timelock visibility. No upgrade
authority survives launch, so this is the ONLY venue-change path.

**Maintenance cadence:** NYSE publishes the holiday + early-closings calendar
**three years at a time** (2026–2028 was released 2025-12-23; expect
2027–2029 around Dec 2026). The release is a press release on ICE IR + the
nyse.com hours page. On each release: update
`scripts/lib/nyse-holidays.json` (34 of 40 override slots used through
2028), then `anchor run init-calendar` — one tx queues both parts; the next
bell activates. Verify with `anchor run cal-check` (prints upcoming bells
from the live PDA).

**Freeze endgame:** rotating sessions to
`11111111111111111111111111111111` (the burn address — nobody can sign it)
freezes the schedule forever; the protocol runs on the last published hours
permanently. Recommended sequence: transfer to the ops multisig first (a
DST-law change — Congress floats permanent-DST bills regularly — would shift
bell times by an hour and you'd want the knob alive); freeze only if the
community explicitly votes to hard-freeze. Freeze is irreversible; there is
no unfreeze.

## 4. Transfer how-to (every step is one command)

All rotations run as the CURRENT holder (a wallet, or a Squads proposal when
the holder is already the vault PDA). Each send echoes the destination
pubkey first (and flags the irreversible freeze address).

Convention (AGENTS.md): every command below runs through `anchor run …` —
the provider wallet + cluster come from Anchor.toml / `solana config`, one
source of truth on every machine. Never invoke these as raw
`npx ts-node scripts/…`. The one exception is the Squads multisig CLI, which
lives in the retired `buyer/` repo (`yarn squads`, no anchor project there) —
it is standalone ops tooling, unrelated to the retired snipe flow.

```bash
# Ops bundle → multisig (amm + staking + crank bounty):
NEW_AUTHORITY=<squads-vault-pda> anchor run rotate-authorities

# Calendar (hours + holidays) → multisig (post-NYSE-transition):
NEW_AUTHORITY=<squads-vault-pda> WHICH=calendar anchor run rotate-authorities

# Freeze the schedule knob forever (irreversible):
NEW_AUTHORITY=11111111111111111111111111111111 WHICH=calendar anchor run rotate-authorities

# Pin / clear the circuit-breaker SPYx pool pair:
anchor run set-halt-pools            # mainnet default: the verified SPYx pair
HALT_POOLS=0 anchor run set-halt-pools   # disarm

# Rotate the keeper hot wallet (amm set_keeper — do this BEFORE the ops
# bundle so the multisig never holds a hot key):
# (see scripts/amm-* tooling; keeper ≠ authority)

# Verify everything:
anchor run check-authorities                              # expect launch wallet
EXPECTED_AUTHORITY=<ops-pda> anchor run check-authorities # after ops rotation
EXPECTED_CALENDAR=<-or-multisig-or-burn> \
  EXPECTED_AUTHORITY=<ops-pda> anchor run check-authorities
```

**Program upgrade authorities** (deploy-side, not account fields):

```bash
# Renounce (immutable — the launch default; do AFTER the final audit-pass deploy):
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority 11111111111111111111111111111111
# Or hand to the treasury multisig instead (keeps a recovery path; a bigger standing key):
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <multisig-pda>
```

If upgrade authorities are renounced at launch, the calendar-as-data split
means nothing above ever needs a redeploy — that was the point. (The 2026
Arca/NYSE hours expansion was DECLINED 2026-09-27: session times stay the
classic bells, frozen at init, so there is no hours knob to worry about at
all.)

## 5. How Squads multisigs actually work (the mechanics)

- A Squad is an on-chain multisig whose **vault PDA** becomes the authority.
  The vault never signs a plain tx — members create **proposals** (draft →
  approve ×threshold → execute), and execution is permissionless once the
  threshold is met. ([docs.squads.so](https://docs.squads.so))
- **No individual member can move anything or rotate any authority** — a
  single member's key being compromised costs nothing below the threshold.
  Membership changes and authority transfers are themselves proposals.
- **Restrictions:** there is NO native "must hold X tokens" gating — that
  would need a custom governor program (don't). What Squads gives you:
  threshold size (2-of-3 / 3-of-5), **time locks** (delay between approval
  and execution), optional per-member **spending limits** and
  proposer/voter/executor roles (some of those are Squads Pro features,
  ~$399/mo — the free tier covers threshold + timelock, which is all this
  protocol needs). Best practice from their docs: approve and execute as
  SEPARATE steps, not "approve + execute" combined.
- **Self-management:** once an authority is the vault PDA, further changes
  happen via proposals forever — including adding/removing members. The
  bootstrap risk window is the moment of transfer (a misconfigured vault is
  unrecoverable), so: create the Squad, verify members/threshold in the UI, run the
  rotation, then re-run `check-authorities` with
  `EXPECTED_AUTHORITY=<vault>`.

## 5b. Choosing multisig members (when the community shows up)

- **Squads** (squads.so) — Solana-native, the vault PDA signs via proposals,
  and `rotate-authorities` already works with it. 2-of-3 for ops, 3-of-5 for
  anything touching custody.
- Members: people whose identity is public in the community, ideally across
  time zones (the calendar ceremony has bells at 04:00 ET), each running
  their own wallet + backed-up seed. No two members on one device/manager.
- Set a proposal threshold of 2 and a transaction limit on the vault for
  day-to-day; single-signer moves for the calendar ceremony are fine BECAUSE
  the knob is fail-safe-only.
- Do not rush this at launch. Every month -only is a month of simpler
  ops; the checklist's pre-launch story ("authorities = launch wallet") is
  already the honest, disclosed state. Rotate when real users ask, not
  before — and say so publicly when you do; the transfer itself is good
  marketing ("the schedule keys move to the community" is a post).

## 6. Rehearsing the transfers (do this on DEVNET, before ever rotating on mainnet)

The rotation LOGIC is unit-tested (litesvm: authority gates, calendar
rotation, burn-address freeze, legacy migration). The part that can only be
rehearsed live is the Squads side + the exact command sequence:

**Fully scriptable — no browser needed.** `yarn squads …` in the retired
`buyer/` repo (buyer/src/squads.ts — standalone ops tooling) drives the whole
multisig with its own member keys: `find` (locate a squad by member), `status`, `propose`
(protocol ixs: halt-pools / tz / holidays / cpmm-pool / sol-usdc-pool /
keeper / rotate), `approve` (signs with every local member key), `execute`,
and `run` (all three). It targets the V2 Squads program — what
devnet.squads.so AND the public client use (the V3 program is not deployed
on devnet; a mainnet V3 squad through the current app will need a small V3
path added to that file).

1. **Create a throwaway Squad on devnet** (devnet.squads.so until 2026-10-01,
   then the public client / backup.v3.squads.so; or any UI — the CLI works
   with whatever exists on-chain): 2-of-3, members = your devnet keypairs.
   Copy the **vault PDA** (`yarn squads find MEMBER=<pk>` finds it).
2. **Rotate one real knob on devnet**: `WHICH=crank` first (smallest blast
   radius). In the Squads UI, create a proposal whose transaction is exactly
   the printed `set_authority` instruction (Squads supports raw/instruction
   builders; or use the CLI). Approve ×2, execute.
3. **Verify**: `EXPECTED_AUTHORITY=<vault> anchor run check-authorities` —
   the crank line must go ✓ while the others still expect your wallet.
4. **Rotate it BACK** with a second proposal (the recovery path you hope to
   never need on mainnet, proven once here).
5. **Repeat for amm, staking, calendar** until the proposal mechanics are
   boring.
6. **Freeze rehearsal (devnet only)**:
   `NEW_AUTHORITY=11111111111111111111111111111111 WHICH=calendar anchor run rotate-authorities`
   → `check-authorities` shows the burn address → any `set_holidays` /
   `set_timezone` / `set_halt_pools` now fails 6003 → redeploy devnet to
   recover. Mainnet has no recovery.
7. **Squads features to poke while there**: timelock setting, member
   add/remove (a proposal!), the Inspector for decoding your multisig
   account, and whether spending limits/roles are worth Squads Pro for you
   (free tier covers threshold + timelock, which is all this protocol needs).

Rule of thumb: every command in §4 that you plan to run on mainnet after
launch, run on devnet first against a multisig you control end-to-end.

## 6b. Post-launch / --final checklist (the one true list)

2. [ ] `solana program set-upgrade-authority … 111…1` for amm, staking,
       crank-oracle (or → treasury multisig if you want a recovery path).
       NOTE: the pool-pin ownership gates (rows 1+4) ship in THIS build —
       renouncing makes them permanent, which is the point: validate identity
       (real Raydium pools), never value, so a genuine rotation can never be
       self-DoSed by the gate.
3. [x] Delete devnet-only instructions before the final crank-oracle deploy:
       `test_set_state`, `test_collect_bounty` + the keeper `--test-state`
       machinery + `scripts/devnet/set-oracle-state.ts` — DONE 2026-10-15 in
       this tree (all four crank test ixs, all four amm devnet ixs, the devnet
       keeper and every devnet script).
4. [ ] LP decision (checklist §5): burn-all (default, no custody tier
       exists) — or retain a slice → treasury multisig from day one.
5. [ ] `anchor run check-authorities` green with the launch wallet.
6. [ ] Later, at community time: §2 rotations + `EXPECTED_*` re-check; the
       first calendar ceremony under the multisig is a post of its own.
7. [ ] Sessions knob (§3): classic bells are permanent (hours adoption was
       declined 2026-09-27) — the only §3 follow-up is the eventual
       transfer-or-freeze decision for the tz/holiday data, driven by the
       community, not by any NYSE change. Document the choice on the
       /authority page.
