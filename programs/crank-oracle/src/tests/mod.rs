//! The crank-oracle suite. Golden calendar tests pin the evaluator to real
//! NYSE dates; litesvm tests exercise the full instruction surface (bounty
//! race, pending activation, migrations, circuit breaker) against the
//! deployed .so; the IDL test locks the wire contract.

use crate::calendar::*;
use crate::constants::*;
use crate::state::*;
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
    transaction::TransactionError,
};
use std::sync::atomic::{AtomicU64, Ordering};

static TX_COUNTER: AtomicU64 = AtomicU64::new(0);

// ─────────────────────── test calendar (NYSE 2026) ──────────────────────────
// The PROGRAM has no NYSE constants; tests supply them as data, exactly like
// scripts/launch/init-calendar.ts does on devnet.
const WEEKDAYS: u8 = 0b0001_1111; // Mon..Fri (bit i = weekday i, 0 = Monday)

fn default_calendar() -> CalendarData {
    let mut cd = CalendarData {
        version: 0,
        updated_at: 0,
        utc_offset_winter: -18_000, // EST
        dst_delta_sec: 3_600,       // EDT
        dst_start: CalendarDateRule { month: 3, week: 2, weekday: 6 }, // 2nd Sunday of March
        dst_end: CalendarDateRule { month: 11, week: 1, weekday: 6 },  // 1st Sunday of November
        half_day_close_min: 780,    // 13:00 ET
        rules: [SessionRule { days_mask: 0, start_min: 0, end_min: 0, state: 0 }; MAX_RULES],
        rule_count: 3,
        overrides: [CalendarOverride { date: 0, kind: 0 }; MAX_OVERRIDES],
        override_count: 0,
    };
    cd.rules[0] = SessionRule { days_mask: WEEKDAYS, start_min: 240, end_min: 570, state: 1 };  // 04:00–09:30 pre
    cd.rules[1] = SessionRule { days_mask: WEEKDAYS, start_min: 570, end_min: 960, state: 0 };  // 09:30–16:00 regular
    cd.rules[2] = SessionRule { days_mask: WEEKDAYS, start_min: 960, end_min: 1200, state: 1 }; // 16:00–20:00 post
    cd
}

/// unix ts of an ET wall-clock time on a given civil date (same day-granular
/// DST rule as the evaluator; test dates avoid edges).
fn et(y: i64, m: u32, d: u32, hh: i64, mm: i64) -> i64 {
    let cal = default_calendar();
    abs_local_minute(&cal, days_from_civil(y, m, d), ((hh * 60 + mm) as u16).min(1440))
}

// ─────────────────────── CLMM pool fakes ────────────────────────────────────

/// Integer square root (Newton) — builds sqrtPriceX64 from a raw ratio the
/// same way the CLMM math does: sqrt(ratio · 2^64).
fn isqrt(x: u128) -> u128 {
    if x == 0 {
        return 0;
    }
    let mut r = x;
    let mut y = (x + 1) / 2;
    while y < r {
        r = y;
        y = (r + x / r) / 2;
    }
    r
}

fn sqrt_x64_of(ratio: u128) -> u128 {
    isqrt(ratio << 64)
}

/// The raw pool ratio the program derives from a sqrtPriceX64 — used to
/// assert captured references.
fn pool_raw(sqrt: u128) -> i64 {
    ((sqrt * sqrt) >> 64) as i64
}

/// Build a Raydium CLMM PoolState-shaped account (halt.rs wire map) with
/// 6/6-decimal mints and the given sqrt price.
fn clmm_pool_data(sqrt: u128, mint_a: &Pubkey, mint_b: &Pubkey) -> Vec<u8> {
    use crate::halt::{CLMM_OFF_DECIMALS, CLMM_OFF_MINT_A, CLMM_OFF_MINT_B, CLMM_OFF_SQRT_PRICE, CLMM_POOL_SPACE};
    let mut d = vec![0u8; CLMM_POOL_SPACE];
    d[9..41].copy_from_slice(&[7u8; 32]); // ammConfig (unchecked)
    d[41..73].copy_from_slice(&[7u8; 32]); // creator (unchecked)
    d[CLMM_OFF_MINT_A..CLMM_OFF_MINT_A + 32].copy_from_slice(mint_a.as_ref());
    d[CLMM_OFF_MINT_B..CLMM_OFF_MINT_B + 32].copy_from_slice(mint_b.as_ref());
    d[137..169].copy_from_slice(&[8u8; 32]); // vaultA (unchecked)
    d[169..201].copy_from_slice(&[9u8; 32]); // vaultB (unchecked)
    d[201..233].copy_from_slice(&[10u8; 32]); // observation (unchecked)
    d[CLMM_OFF_DECIMALS] = 6;
    d[CLMM_OFF_DECIMALS + 1] = 6;
    d[235..237].copy_from_slice(&10u16.to_le_bytes()); // tickSpacing
    d[237..253].copy_from_slice(&1_000_000_000_000u128.to_le_bytes()); // liquidity
    d[CLMM_OFF_SQRT_PRICE..CLMM_OFF_SQRT_PRICE + 16]
        .copy_from_slice(&sqrt.to_le_bytes());
    d
}

/// Set both pinned pool accounts at the given raw ratios.
fn set_pools(f: &mut Fixture, ratio_a: u128, ratio_b: u128) {
    set_pools_raw(&mut f.svm, &f.pool_a, &f.pool_b, &f.mint_a, &f.mint_b, ratio_a, ratio_b);
}

fn set_pools_raw(
    svm: &mut LiteSVM,
    a: &Pubkey,
    b: &Pubkey,
    mint_a: &Pubkey,
    mint_b: &Pubkey,
    ratio_a: u128,
    ratio_b: u128,
) {
    for (key, ratio) in [(a, ratio_a), (b, ratio_b)] {
        let data = clmm_pool_data(sqrt_x64_of(ratio), mint_a, mint_b);
            svm.set_account(
                *key,
                solana_sdk::account::Account {
                    lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: CLMM_PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
}

// ──────────────────────────── litesvm harness ───────────────────────────────

fn svm_with_program() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let so_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy/crank_oracle.so");
    let bytes = std::fs::read(&so_path)
        .unwrap_or_else(|_| panic!("missing {} — run `anchor build` first", so_path.display()));
    svm.add_program(ID, &bytes);
    svm
}

fn send(
    svm: &mut LiteSVM,
    ix: Instruction,
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    // litesvm's blockhash is static AND validated, so identical txs would
    // collide on the deterministic signature ("AlreadyProcessed"). A
    // counter-valued payer→payer transfer makes every tx unique.
    let blockhash = svm.latest_blockhash();
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend(signers);
    let mut ixs = vec![ix];
    let n = TX_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    ixs.push(solana_sdk::system_instruction::transfer(
        &payer.pubkey(),
        &payer.pubkey(),
        n,
    ));
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &all, blockhash);
    svm.send_transaction(tx)
}

/// Warp slot AND the Clock sysvar.
fn set_clock(svm: &mut LiteSVM, slot: u64, ts: i64) {
    svm.warp_to_slot(slot);
    let mut clock = svm.get_sysvar::<solana_sdk::clock::Clock>();
    clock.slot = slot;
    clock.unix_timestamp = ts;
    svm.set_sysvar::<solana_sdk::clock::Clock>(&clock);
}

fn calendar_key() -> Pubkey {
    Pubkey::find_program_address(&[SEED_MARKET_CALENDAR], &ID).0
}
fn market_key() -> Pubkey {
    Pubkey::find_program_address(&[SEED_MARKET_STATUS], &ID).0
}
fn cfg_key() -> Pubkey {
    Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).0
}
fn vault_key() -> Pubkey {
    Pubkey::find_program_address(&[SEED_BOUNTY_VAULT], &ID).0
}
fn halt_key() -> Pubkey {
    Pubkey::find_program_address(&[SEED_HALT_STATE], &ID).0
}

fn init_calendar_ix(payer: &Pubkey, cd: &CalendarData) -> Instruction {
    let mut data = DISC_INITIALIZE_CALENDAR.to_vec();
    data.extend_from_slice(&calendar_data_to_bytes(cd));
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(calendar_key(), false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data,
    }
}

/// tz/DST part: utc_offset(4)+dst_delta(4)+dst_start(3)+dst_end(3) = [12..26].
fn timezone_ix(authority: &Pubkey, cd: &CalendarData) -> Instruction {
    let mut data = DISC_SET_TIMEZONE.to_vec();
    let b = calendar_data_to_bytes(cd);
    data.extend_from_slice(&b[12..12 + TIMEZONE_PART_SPACE]);
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(calendar_key(), false),
        ],
        data,
    }
}

fn holidays_ix(authority: &Pubkey, cd: &CalendarData) -> Instruction {
    let mut data = DISC_SET_HOLIDAYS.to_vec();
    let b = calendar_data_to_bytes(cd);
    data.extend_from_slice(&b[77..77 + OVERRIDES_PART_SPACE]);
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(calendar_key(), false),
        ],
        data,
    }
}

fn set_halt_pools_ix(authority: &Pubkey, a: &Pubkey, b: &Pubkey) -> Instruction {
    let mut data = DISC_SET_HALT_POOLS.to_vec();
    data.extend_from_slice(a.as_ref());
    data.extend_from_slice(b.as_ref());
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(calendar_key(), false),
            AccountMeta::new(cfg_key(), false),
            // Pin-time ownership proof: the pool accounts themselves
            // (read-only, CLMM-owned — validated by the handler).
            AccountMeta::new_readonly(*a, false),
            AccountMeta::new_readonly(*b, false),
        ],
        data,
    }
}

fn init_bounty_ix(payer: &Pubkey, bounty_amount: u64, pool: Pubkey, cpmm: Pubkey, usdc: Pubkey) -> Instruction {
    let mut args = Vec::new();
    args.extend_from_slice(&bounty_amount.to_le_bytes());
    args.extend_from_slice(&750_000u64.to_le_bytes());
    args.extend_from_slice(&2026u16.to_le_bytes());
    args.extend_from_slice(&500u16.to_le_bytes());
    args.extend_from_slice(pool.as_ref());
    args.extend_from_slice(cpmm.as_ref());
    args.extend_from_slice(usdc.as_ref());
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(cfg_key(), false),
            AccountMeta::new(vault_key(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: [DISC_INITIALIZE_BOUNTY.to_vec(), args].concat(),
    }
}

fn fund_ix(payer: &Keypair, amount: u64) -> Instruction {
    let mut args = Vec::new();
    args.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(cfg_key(), false),
            AccountMeta::new(vault_key(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: [DISC_FUND_BOUNTY.to_vec(), args].concat(),
    }
}

/// Crank ix. `pools` = None passes the system-program placeholders for both
/// halt pool slots.
fn crank_ix(
    cranker: &Keypair,
    pools: Option<(Pubkey, Pubkey)>,
    sol_vaults: Option<(Pubkey, Pubkey)>,
) -> Instruction {
    let sys = solana_sdk::system_program::id();
    let (pa, pb) = pools.unwrap_or((sys, sys));
    let mut accounts = vec![
        AccountMeta::new(cranker.pubkey(), true),
        AccountMeta::new(cfg_key(), false),
        AccountMeta::new(vault_key(), false),
        AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        AccountMeta::new(market_key(), false),
        AccountMeta::new(calendar_key(), false),
        AccountMeta::new(halt_key(), false),
        AccountMeta::new_readonly(pa, false),
        AccountMeta::new_readonly(pb, false),
    ];
    if let Some((w, u)) = sol_vaults {
        accounts.push(AccountMeta::new_readonly(w, false));
        accounts.push(AccountMeta::new_readonly(u, false));
    }
    accounts.push(AccountMeta::new_readonly(sys, false));
    Instruction {
        program_id: ID,
        accounts,
        data: DISC_PERMISSIONLESS_CRANK.to_vec(),
    }
}

struct Fixture {
    svm: LiteSVM,
    authority: Keypair,
    cranker: Keypair,
    intruder: Keypair,
    pool_a: Pubkey,
    pool_b: Pubkey,
    mint_a: Pubkey,
    mint_b: Pubkey,
}

fn setup() -> Fixture {
    setup_with(false)
}

/// `pin_pools` additionally arms the breaker (two fresh pool/mint keys).
fn setup_with(pin_pools: bool) -> Fixture {
    let mut svm = svm_with_program();
    let authority = Keypair::new();
    let cranker = Keypair::new();
    let intruder = Keypair::new();
    for k in [&authority, &cranker, &intruder] {
        svm.airdrop(&k.pubkey(), 5_000_000_000).unwrap();
    }

    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(market_key(), false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: DISC_INITIALIZE_STATE.to_vec(),
    };
    send(&mut svm, ix, &authority, &[]).unwrap();

    send(&mut svm, init_calendar_ix(&authority.pubkey(), &default_calendar()), &authority, &[]).unwrap();

    // Pre-create the halt_state PDA (in production the first cranker funds
    // its one-time rent; pre-creating keeps the bounty-delta assertions
    // below exact).
    let mut halt_data = vec![0u8; HALT_STATE_SPACE as usize];
    halt_data[..8].copy_from_slice(&DISC_HALT_STATE);
    svm.set_account(
        halt_key(),
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(HALT_STATE_SPACE as usize),
            data: halt_data,
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    send(
        &mut svm,
        init_bounty_ix(&authority.pubkey(), 10_000_000, Pubkey::default(), Pubkey::default(), Pubkey::default()),
        &authority,
        &[],
    )
    .unwrap();

    // Pin the test venues — the calendar authority re-points them via
    // set_halt_pools (a fresh config defaults to the mainnet pair). The
    // pin validates venue OWNERSHIP now, so install CLMM-shaped pool
    // accounts BEFORE pinning (neutral 1:1 ratio — tests overwrite these).
    let pool_a = Pubkey::new_unique();
    let pool_b = Pubkey::new_unique();
    let mint_a = Pubkey::new_unique();
    let mint_b = Pubkey::new_unique();
    if pin_pools {
        set_pools_raw(&mut svm, &pool_a, &pool_b, &mint_a, &mint_b, 1, 1);
        send(&mut svm, set_halt_pools_ix(&authority.pubkey(), &pool_a, &pool_b), &authority, &[]).unwrap();
    }

    Fixture { svm, authority, cranker, intruder, pool_a, pool_b, mint_a, mint_b }
}

fn account_info<'a>(key: &'a Pubkey, acct: &'a mut solana_sdk::account::Account) -> solana_program::account_info::AccountInfo<'a> {
    solana_program::account_info::AccountInfo::new(
        key, false, false, &mut acct.lamports, &mut acct.data, &acct.owner, acct.executable, acct.rent_epoch,
    )
}

fn read_market(svm: &LiteSVM) -> MarketStatus {
    let key = market_key();
    let mut acct = svm.get_account(&key).unwrap();
    read_market_status(&account_info(&key, &mut acct)).unwrap()
}
fn read_cfg(svm: &LiteSVM) -> BountyConfig {
    let key = cfg_key();
    let mut acct = svm.get_account(&key).unwrap();
    read_bounty_config(&account_info(&key, &mut acct)).unwrap()
}
fn read_cal(svm: &LiteSVM) -> MarketCalendar {
    let key = calendar_key();
    let mut acct = svm.get_account(&key).unwrap();
    read_market_calendar(&account_info(&key, &mut acct)).unwrap()
}
fn read_halt(svm: &LiteSVM) -> HaltState {
    let key = halt_key();
    let mut acct = svm.get_account(&key).unwrap();
    read_halt_state(&account_info(&key, &mut acct)).unwrap()
}

// ─────────────────────── golden: civil-date arithmetic ──────────────────────

#[test]
fn civil_helpers_golden() {
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(weekday_from_days(0), 3, "1970-01-01 was a Thursday");
    assert_eq!(days_from_civil(2026, 1, 1) * 86_400, 1_767_225_600);
    assert_eq!(civil_from_days(1_767_225_600 / 86_400), (2026, 1, 1));
    assert_eq!(weekday_from_days(1_767_225_600 / 86_400), 3, "2026-01-01 was a Thursday");
    assert_eq!(weekday_from_days(days_from_civil(2026, 9, 22)), 1, "2026-09-22 is a Tuesday");
    assert_eq!(weekday_from_days(days_from_civil(2026, 12, 25)), 4, "2026-12-25 is a Friday");
    let feb_len = |y: i64| days_from_civil(y, 3, 1) - days_from_civil(y, 2, 1);
    assert_eq!(feb_len(2026), 28);
    assert_eq!(feb_len(2028), 29, "2028 is a leap year");
    assert_eq!(nth_weekday_day(2026, 3, 6, 2), 8, "2nd Sunday of March 2026 = the 8th");
    assert_eq!(nth_weekday_day(2026, 11, 3, 4), 26, "4th Thursday of Nov 2026 = the 26th");
}

// ─────────────────────── golden: calendar evaluation ────────────────────────

#[test]
fn default_calendar_states() {
    let cal = default_calendar();
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 3, 59)), 2);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 4, 0)), 1);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 9, 29)), 1);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 9, 30)), 0);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 15, 59)), 0);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 16, 0)), 1);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 19, 59)), 1);
    assert_eq!(eval_state(&cal, et(2026, 9, 22, 20, 0)), 2);
    assert_eq!(eval_state(&cal, et(2026, 9, 19, 12, 0)), 2, "Saturday closed");
    assert_eq!(eval_state(&cal, et(2026, 9, 20, 12, 0)), 2, "Sunday closed");
}

#[test]
fn dst_transition_follows_data() {
    let cal = default_calendar();
    assert_eq!(eval_state(&cal, et(2026, 3, 6, 10, 0)), 0);
    assert_eq!(eval_state(&cal, et(2026, 3, 9, 10, 0)), 0);
    let fri = et(2026, 3, 6, 10, 0);
    let mon = et(2026, 3, 9, 10, 0);
    assert_eq!((mon - fri) % 86_400, 86_400 - 3_600, "spring-forward: the ET day is 23h long in UTC");
    // No-DST calendar: the offset stays at winter all year, so the same
    // instant reads one hour EARLIER on the wall clock (11:00 EDT-built ==
    // 10:00 EST) and must still be in the regular session.
    let mut nodst = default_calendar();
    nodst.dst_delta_sec = 0;
    assert_eq!(eval_state(&nodst, et(2026, 3, 9, 11, 0)), 0);
}

#[test]
fn holiday_and_half_day_overrides() {
    let mut cal = default_calendar();
    cal.overrides[0] = CalendarOverride { date: days_from_civil(2026, 12, 25) as u32, kind: 0 };
    cal.overrides[1] = CalendarOverride { date: days_from_civil(2026, 11, 26) as u32, kind: 1 };
    cal.override_count = 2;
    assert_eq!(eval_state(&cal, et(2026, 12, 25, 11, 0)), 2);
    assert_eq!(eval_state(&cal, et(2026, 11, 26, 12, 0)), 0);
    assert_eq!(eval_state(&cal, et(2026, 11, 26, 12, 59)), 0);
    assert_eq!(eval_state(&cal, et(2026, 11, 26, 13, 0)), 1);
    assert_eq!(eval_state(&cal, et(2026, 11, 26, 16, 59)), 1);
    assert_eq!(eval_state(&cal, et(2026, 11, 26, 17, 0)), 2);
    assert_eq!(eval_state(&cal, et(2026, 11, 26, 8, 0)), 1);
}

#[test]
fn boundary_timestamps_are_exact_bells() {
    let cal = default_calendar();
    let t = et(2026, 9, 22, 9, 30);
    assert_eq!(last_boundary(&cal, t), t);
    assert_eq!(last_boundary(&cal, t + 30), t, "09:30:30 attributes to the 09:30 bell");
    assert_eq!(last_boundary(&cal, et(2026, 9, 22, 16, 0) + 5), et(2026, 9, 22, 16, 0));
    assert_eq!(last_boundary(&cal, et(2026, 9, 22, 20, 0) + 5), et(2026, 9, 22, 20, 0));
    assert_eq!(last_boundary(&cal, et(2026, 9, 22, 23, 0)), et(2026, 9, 22, 20, 0));
    assert_eq!(last_boundary(&cal, et(2026, 9, 20, 19, 0)), et(2026, 9, 18, 20, 0));
}

// ─────────────────────────── on-chain: lifecycle ────────────────────────────

#[test]
fn init_writes_sentinel_config_and_calendar() {
    let f = setup();
    let m = read_market(&f.svm);
    assert_eq!(m.state, 99, "fail-closed sentinel");
    let c = read_cfg(&f.svm);
    assert_eq!(c.authority, f.authority.pubkey());
    assert_eq!(c.bounty_amount, 10_000_000);
    assert_eq!(c.bounty_usd_raw, 750_000);
    let cal = read_cal(&f.svm);
    assert_eq!(cal.active.version, 1);
    assert_eq!(cal.active.rule_count, 3);
    assert_eq!(cal.calendar_authority, f.authority.pubkey());
    assert!(!cal.has_pending);
    let cfg_acct = f.svm.get_account(&cfg_key()).unwrap();
    assert_eq!(cfg_acct.data.len(), BOUNTY_CONFIG_SPACE as usize);
    let cal_acct = f.svm.get_account(&calendar_key()).unwrap();
    assert_eq!(cal_acct.data.len(), MARKET_CALENDAR_SPACE as usize);
}

#[test]
fn crank_without_calendar_fails() {
    let mut svm = svm_with_program();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 5_000_000_000).unwrap();
    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(market_key(), false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: DISC_INITIALIZE_STATE.to_vec(),
    };
    send(&mut svm, ix, &authority, &[]).unwrap();
    send(
        &mut svm,
        init_bounty_ix(&authority.pubkey(), 10_000_000, Pubkey::default(), Pubkey::default(), Pubkey::default()),
        &authority,
        &[],
    )
    .unwrap();
    set_clock(&mut svm, 10, et(2026, 9, 22, 10, 0));
    let e = send(&mut svm, crank_ix(&authority, None, None), &authority, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::InvalidAccountData)
    );
}

#[test]
fn transition_heartbeat_day_rollover_and_exact_bells() {
    let mut f = setup();
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();

    set_clock(&mut f.svm, 100, et(2026, 9, 22, 9, 31));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    let m = read_market(&f.svm);
    assert_eq!(m.state, 0);
    assert_eq!(m.last_updated_timestamp, et(2026, 9, 22, 9, 31), "genesis ts = now");
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports - before, 10_000_000);

    set_clock(&mut f.svm, 110, et(2026, 9, 22, 10, 0));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports, before, "heartbeat pays nothing");
    assert_eq!(read_cfg(&f.svm).last_crank_slot, 110);

    set_clock(&mut f.svm, 120, et(2026, 9, 22, 16, 1));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports - before, 10_000_000);
    let m = read_market(&f.svm);
    assert_eq!(m.state, 1);
    assert_eq!(m.last_updated_timestamp, et(2026, 9, 22, 16, 0), "exact bell");

    set_clock(&mut f.svm, 130, et(2026, 9, 22, 20, 1));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports - before, 10_000_000);
    let m = read_market(&f.svm);
    assert_eq!(m.state, 2);
    assert_eq!(m.trading_day_index, 0, "the close does not roll the day — the open does");
    assert_eq!(m.last_updated_timestamp, et(2026, 9, 22, 20, 0));

    set_clock(&mut f.svm, 140, et(2026, 9, 26, 12, 0));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports, before, "Saturday is a free heartbeat");
    assert_eq!(read_market(&f.svm).state, 2);

    // Monday's open bell (closed→regular) is where the trading day rolls.
    set_clock(&mut f.svm, 150, et(2026, 9, 28, 9, 31));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports - before, 10_000_000);
    let m = read_market(&f.svm);
    assert_eq!(m.state, 0);
    assert_eq!(m.trading_day_index, 1, "(1|2)→0 at the open rolls the trading day");
    assert_eq!(m.last_updated_timestamp, et(2026, 9, 28, 9, 30));
}

#[test]
fn same_slot_crank_rejected() {
    let mut f = setup();
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    set_clock(&mut f.svm, 100, et(2026, 9, 22, 9, 31));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    let e = send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_STALE_QUOTE))
    );
}

#[test]
fn transition_fails_when_vault_too_low() {
    let mut f = setup();
    set_clock(&mut f.svm, 100, et(2026, 9, 22, 9, 31));
    let e = send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.cranker, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_BOUNTY_EXHAUSTED))
    );
    assert_eq!(read_market(&f.svm).state, 99);
    assert_eq!(read_cfg(&f.svm).last_crank_slot, 0);
}

// ─────────────────────────── on-chain: calendar knobs ───────────────────────

#[test]
fn calendar_setters_authority_and_validation_gates() {
    let mut f = setup();
    let e = send(&mut f.svm, timezone_ix(&f.intruder.pubkey(), &default_calendar()), &f.intruder, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_AUTHORITY))
    );
    let mut bad = default_calendar();
    bad.overrides[0] = CalendarOverride { date: 20_000, kind: 0 };
    bad.overrides[1] = CalendarOverride { date: 19_999, kind: 0 };
    bad.override_count = 2;
    let e = send(&mut f.svm, holidays_ix(&f.authority.pubkey(), &bad), &f.authority, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_CALENDAR_DATA))
    );
    // Valid tz/DST update queues; the SAME part again → 6013; the
    // holidays part may still queue on top.
    send(&mut f.svm, timezone_ix(&f.authority.pubkey(), &default_calendar()), &f.authority, &[]).unwrap();
    let cal = read_cal(&f.svm);
    assert!(cal.has_pending && cal.pending_schedule && !cal.pending_holidays);
    let e = send(&mut f.svm, timezone_ix(&f.authority.pubkey(), &default_calendar()), &f.authority, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_CALENDAR_PENDING_EXISTS))
    );
    send(&mut f.svm, holidays_ix(&f.authority.pubkey(), &default_calendar()), &f.authority, &[]).unwrap();
    let cal = read_cal(&f.svm);
    assert!(cal.has_pending && cal.pending_schedule && cal.pending_holidays);
}

#[test]
fn pending_calendar_activates_at_next_bell() {
    let mut f = setup();
    send(&mut f.svm, fund_ix(&f.authority, 200_000_000), &f.authority, &[]).unwrap();

    set_clock(&mut f.svm, 100, et(2026, 9, 22, 9, 31));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0);

    // v2 runs the clock an hour ahead (UTC-4 std) — once activated, every
    // bell lands an hour earlier in unix terms.
    let mut v2 = default_calendar();
    v2.utc_offset_winter = -14_400;
    send(&mut f.svm, timezone_ix(&f.authority.pubkey(), &v2), &f.authority, &[]).unwrap();

    set_clock(&mut f.svm, 110, et(2026, 9, 22, 15, 0));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert!(read_cal(&f.svm).has_pending, "no bell yet — pending waits");
    assert_eq!(read_market(&f.svm).state, 0);

    set_clock(&mut f.svm, 120, et(2026, 9, 22, 16, 1));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    let cal = read_cal(&f.svm);
    assert!(!cal.has_pending, "activated at the bell");
    assert_eq!(cal.active.version, 2);
    assert_eq!(cal.active.utc_offset_winter, -14_400);
    let m = read_market(&f.svm);
    assert_eq!(m.state, 1);
    // Bell ts re-derived under the ACTIVATED calendar: v2's 16:00-local
    // close = 15:00 wall-et on the old clock.
    assert_eq!(m.last_updated_timestamp, et(2026, 9, 22, 15, 0));

    // v2's 20:00 post-close bell = 19:00 wall-et under the old clock.
    set_clock(&mut f.svm, 130, et(2026, 9, 22, 19, 1));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    let m = read_market(&f.svm);
    assert_eq!(m.state, 2);
    assert_eq!(m.trading_day_index, 0, "the close doesn't roll — next morning's open does");
    assert_eq!(m.last_updated_timestamp, et(2026, 9, 22, 19, 0), "new schedule's bell");
}

#[test]
fn calendar_authority_rotation() {
    let mut f = setup();
    let new_authority = Pubkey::new_unique();
    let mut data = DISC_SET_CALENDAR_AUTHORITY.to_vec();
    data.extend_from_slice(new_authority.as_ref());
    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(f.authority.pubkey(), true),
            AccountMeta::new(calendar_key(), false),
        ],
        data,
    };
    let mut intruder_ix = ix.clone();
    intruder_ix.accounts[0].pubkey = f.intruder.pubkey();
    let e = send(&mut f.svm, intruder_ix, &f.intruder, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_AUTHORITY))
    );
    send(&mut f.svm, ix, &f.authority, &[]).unwrap();
    assert_eq!(read_cal(&f.svm).calendar_authority, new_authority);
}

// ─────────────────────────── on-chain: circuit breaker ──────────────────────
// Day one captures the reference at the close bell; day two drives both
// pools through the Rule 7.12 thresholds. Prices are raw pool ratios
// (equal-decimal tokens: 600_000_000 reads "600.000000"). Thresholds vs a
// 600_000_000 reference: −7% → 558_000_000, −13% → 522_000_000,
// −20% → 480_000_000; benign sits at −5% (570_000_000).

const REF: u128 = 600_000_000;
const L1: u128 = 539_000_000; // −10.2%: inside L1, outside L2
const L2_LATE: u128 = 516_000_000; // −14%: L2 before the cutoff, close after
const L3: u128 = 474_000_000; // −21%: close any time
const BENIGN: u128 = 570_000_000; // −5%

/// Drive a full Monday so the reference is captured: 09:31 open, 16:01 close
/// with the pools at `ratio`, 20:01 final close.
fn run_reference_day(f: &mut Fixture, slot: &mut u64, ratio: u128) {
    set_clock(&mut f.svm, *slot, et(2026, 9, 21, 9, 31));
    set_pools(f, ratio, ratio);
    send(&mut f.svm, crank_ix(&f.cranker, Some((f.pool_a, f.pool_b)), None), &f.intruder, &[&f.cranker]).unwrap();
    *slot += 10;

    set_clock(&mut f.svm, *slot, et(2026, 9, 21, 16, 1));
    set_pools(f, ratio, ratio);
    send(&mut f.svm, crank_ix(&f.cranker, Some((f.pool_a, f.pool_b)), None), &f.intruder, &[&f.cranker]).unwrap();
    *slot += 10;

    set_clock(&mut f.svm, *slot, et(2026, 9, 21, 20, 1));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    *slot += 10;
}

#[test]
fn no_pools_is_fail_open() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;

    // Monday: run the reference day (also proves open/close cranks work with
    // live, benign pools).
    run_reference_day(&mut f, &mut slot, REF);
    assert_eq!(read_market(&f.svm).trading_day_index, 0, "Monday's close doesn't roll the day");
    let halt = read_halt(&f.svm);
    assert_eq!(halt.ref_price, pool_raw(sqrt_x64_of(REF)), "close-bell pool A price captured");
    assert_eq!(halt.ref_day, days_from_civil(2026, 9, 21) as u32);

    // Tuesday open WITHOUT pools: the breaker is inert (fail-open) — the
    // crank still derives the calendar state and never fabricates a halt.
    set_clock(&mut f.svm, slot, et(2026, 9, 22, 9, 31));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_ne!(read_market(&f.svm).state, 3, "no pools ⇒ no halt");
    assert_eq!(read_market(&f.svm).trading_day_index, 1, "Tuesday's open rolls the day");
}

#[test]
fn set_halt_pools_requires_clmm_ownership() {
    let mut f = setup_with(true);

    // Arg/account mismatch: the pool named in the args is not the account
    // passed alongside them (built inline — the helper derives both from
    // the same keys).
    let stranger = Pubkey::new_unique();
    let mut mismatch_data = DISC_SET_HALT_POOLS.to_vec();
    mismatch_data.extend_from_slice(stranger.as_ref());
    mismatch_data.extend_from_slice(f.pool_b.as_ref());
    let mismatch_ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(f.authority.pubkey(), true),
            AccountMeta::new(calendar_key(), false),
            AccountMeta::new(cfg_key(), false),
            AccountMeta::new_readonly(f.pool_a, false),
            AccountMeta::new_readonly(f.pool_b, false),
        ],
        data: mismatch_data,
    };
    let e = send(&mut f.svm, mismatch_ix, &f.authority, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_HALT_POOL_MISMATCH))
    );

    // Wrong owner: a system-program-owned "pool" is not a CLMM venue.
    let sys = solana_sdk::system_program::id();
    let snapshot = f.svm.get_account(&f.pool_a).unwrap();
    f.svm.set_account(f.pool_a, Account { owner: sys, ..snapshot }).unwrap();
    let e = send(&mut f.svm, set_halt_pools_ix(&f.authority.pubkey(), &f.pool_a, &f.pool_b), &f.authority, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_HALT_POOL_OWNER))
    );

    // The pins were rejected — the config still holds the fixture pair.
    let cfg = read_cfg(&f.svm);
    assert_eq!(cfg.halt_pool_a, f.pool_a, "rejected pins must not partially apply");
    assert_eq!(cfg.halt_pool_b, f.pool_b);

    // The disable path (zero pair) skips venue validation.
    send(&mut f.svm, set_halt_pools_ix(&f.authority.pubkey(), &Pubkey::default(), &Pubkey::default()), &f.authority, &[]).unwrap();
    let cfg = read_cfg(&f.svm);
    assert_eq!(cfg.halt_pool_a, Pubkey::default(), "disable clears the venues");
    assert_eq!(cfg.halt_pool_b, Pubkey::default());
}

#[test]
fn l1_confirms_declares_and_rearms() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 300_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;
    run_reference_day(&mut f, &mut slot, REF);

    // Tuesday 9:31 open on benign pools (a paid 0→1 bell), then 10:00 with
    // both pools −10.2% → first sighting ARMS the confirmation window; the
    // desk stays open, no bounty.
    set_clock(&mut f.svm, slot, et(2026, 9, 22, 9, 31));
    set_pools(&mut f, BENIGN, BENIGN);
    send(&mut f.svm, crank_ix(&f.cranker, Some((f.pool_a, f.pool_b)), None), &f.intruder, &[&f.cranker]).unwrap();
    slot += 1;

    let t1 = et(2026, 9, 22, 10, 0);
    set_clock(&mut f.svm, slot, t1);
    set_pools(&mut f, L1, L1);
    let p = Some((f.pool_a, f.pool_b));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0, "armed, not yet halted");
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports, before, "no bounty for a sighting");
    assert_eq!(read_halt(&f.svm).pending_since, t1);

    // 10:01:01 — breach held across two cranks ≥60s apart → Level-1 halt.
    let t2 = t1 + 61;
    set_clock(&mut f.svm, slot + 1, t2);
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 3, "confirmed breach declares a halt");
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports - before, 10_000_000, "halt declare pays");
    assert_eq!(read_halt(&f.svm).halt_until, t2 + 900, "15-minute overlay");

    // While halted, a still-breaching crank is a heartbeat.
    set_clock(&mut f.svm, slot + 2, t2 + 300);
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 3);
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports, before, "halt heartbeat pays nothing");

    // Overlay expires but the breach persists → re-ARM without churning
    // through an open state: the desk stays halted through confirmation.
    let t3 = t2 + 1000; // past halt_until (t2 + 900)
    set_clock(&mut f.svm, slot + 3, t3);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 3, "no 3→1→3 churn on re-arm");
    let t4 = t3 + 61;
    set_clock(&mut f.svm, slot + 4, t4);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 3);
    assert_eq!(read_halt(&f.svm).halt_until, t4 + 900, "overlay re-armed");

    // Recovered (−5%) after the overlay expiry → resumes, 3→1 pays.
    let t5 = t4 + 2000;
    set_clock(&mut f.svm, slot + 5, t5);
    set_pools(&mut f, BENIGN, BENIGN);
    let p = Some((f.pool_a, f.pool_b));
    let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0, "session resumes inside the threshold");
    assert_eq!(f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports - before, 10_000_000, "resumption pays");
    assert_eq!(read_halt(&f.svm).pending_since, 0);
}

#[test]
fn l2_after_cutoff_and_l3_close_for_day() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 400_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;
    run_reference_day(&mut f, &mut slot, REF);
    let tuesday = days_from_civil(2026, 9, 22) as u32;

    // Tuesday open (benign).
    set_clock(&mut f.svm, slot, et(2026, 9, 22, 9, 31));
    set_pools(&mut f, BENIGN, BENIGN);
    let p = Some((f.pool_a, f.pool_b));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    let day_before = read_market(&f.svm).trading_day_index;

    // 15:30 (after the 15:25 cutoff), both pools −14%: sighting arms…
    set_clock(&mut f.svm, slot + 1, et(2026, 9, 22, 15, 30));
    set_pools(&mut f, L2_LATE, L2_LATE);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0, "armed, day still open");

    // …confirmation at 15:31 → Level 2 after the cutoff CLOSES the day.
    set_clock(&mut f.svm, slot + 2, et(2026, 9, 22, 15, 31));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    let m = read_market(&f.svm);
    assert_eq!(m.state, 2, "L2 after the cutoff closes the day");
    assert_eq!(m.trading_day_index, day_before, "an L3-style mid-session close doesn't roll — the next open does");
    assert_eq!(read_halt(&f.svm).l3_day, tuesday);

    // 16:30: the after-hours session stays shut (remainder of the day).
    set_clock(&mut f.svm, slot + 3, et(2026, 9, 22, 16, 30));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 2, "no after-hours desk after an L3-style close");

    // Wednesday reopens normally (benign pools — inside −7% of Monday's
    // reference, which is still current: Tuesday's L3 day captured none).
    set_clock(&mut f.svm, slot + 4, et(2026, 9, 23, 9, 31));
    set_pools(&mut f, BENIGN, BENIGN);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0, "next session opens on the calendar");

    // Wednesday 11:00, both pools −21% → Level 3 closes Wednesday too
    // (after the usual confirmation).
    set_clock(&mut f.svm, slot + 5, et(2026, 9, 23, 11, 0));
    set_pools(&mut f, L3, L3);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    set_clock(&mut f.svm, slot + 6, et(2026, 9, 23, 11, 2));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 2, "Level 3 closes any time");
}

#[test]
fn one_pool_breach_does_not_halt() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;
    run_reference_day(&mut f, &mut slot, REF);

    // Pool A breaches, pool B holds: the AND rule reads the LESSER severity,
    // so this is a Stand — no arming, no halt, however long it persists.
    for (i, t) in [et(2026, 9, 22, 10, 0), et(2026, 9, 22, 10, 5)].iter().enumerate() {
        set_clock(&mut f.svm, slot + i as u64, *t);
        set_pools(&mut f, L1, BENIGN);
        let p = Some((f.pool_a, f.pool_b));
        send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    }
    let m = read_market(&f.svm);
    assert_eq!(m.state, 0, "single-venue breach never halts");
    let halt = read_halt(&f.svm);
    assert_eq!((halt.halt_until, halt.pending_since), (0, 0));
}

#[test]
fn wick_recovers_without_halting() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;
    run_reference_day(&mut f, &mut slot, REF);

    // A momentary both-pool wick arms the window…
    set_clock(&mut f.svm, slot, et(2026, 9, 22, 10, 0));
    set_pools(&mut f, L1, L1);
    let p = Some((f.pool_a, f.pool_b));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_halt(&f.svm).pending_since, et(2026, 9, 22, 10, 0));

    // …but recovery before the confirmation window disarms it.
    set_clock(&mut f.svm, slot + 1, et(2026, 9, 22, 10, 2));
    set_pools(&mut f, BENIGN, BENIGN);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0);
    assert_eq!(read_halt(&f.svm).pending_since, 0, "recovery disarms the window");

    // A sustained breach still halts afterwards.
    set_clock(&mut f.svm, slot + 2, et(2026, 9, 22, 10, 10));
    set_pools(&mut f, L1, L1);
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    set_clock(&mut f.svm, slot + 3, et(2026, 9, 22, 10, 12));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 3, "sustained breach halts");
}

#[test]
fn stale_sighting_re_arms_instead_of_confirming() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;
    run_reference_day(&mut f, &mut slot, REF);

    // Tuesday 10:00 sighting arms the window; the next breach crank comes
    // 20 minutes later — beyond PENDING_MAX_SPAN — so it must RE-ARM rather
    // than confirm on the spot.
    set_clock(&mut f.svm, slot, et(2026, 9, 22, 10, 0));
    set_pools(&mut f, L1, L1);
    let p = Some((f.pool_a, f.pool_b));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_halt(&f.svm).pending_since, et(2026, 9, 22, 10, 0));

    set_clock(&mut f.svm, slot + 1, et(2026, 9, 22, 10, 20));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0, "stale arming re-arms, no instant halt");
    assert_eq!(read_halt(&f.svm).pending_since, et(2026, 9, 22, 10, 20), "window re-armed");

    set_clock(&mut f.svm, slot + 2, et(2026, 9, 22, 10, 22));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 3, "the fresh window confirms normally");
}

#[test]
fn pool_validation_rejects_bad_accounts() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    let mut slot = 100u64;
    run_reference_day(&mut f, &mut slot, REF);
    let t = et(2026, 9, 22, 9, 31);

    fn expect_crank_err(f: &mut Fixture, slot: u64, t: i64, pools: Option<(Pubkey, Pubkey)>, code: u32) {
        set_clock(&mut f.svm, slot, t);
        let e = send(&mut f.svm, crank_ix(&f.cranker, pools, None), &f.intruder, &[&f.cranker]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(code))
        );
    }

    // Wrong owner (system program owns the "pool").
    set_pools(&mut f, BENIGN, BENIGN);
    let sys = solana_sdk::system_program::id();
    let snapshot = f.svm.get_account(&f.pool_a).unwrap();
    f.svm.set_account(f.pool_a, Account { owner: sys, ..snapshot }).unwrap();
    let p = Some((f.pool_a, f.pool_b));
    expect_crank_err(&mut f, slot, t, p, ERR_HALT_POOL_LAYOUT);

    // Truncated account.
    set_pools(&mut f, BENIGN, BENIGN);
    let mut short = clmm_pool_data(sqrt_x64_of(BENIGN), &f.mint_a, &f.mint_b);
    short.truncate(1000);
    f.svm.set_account(
        f.pool_a,
        Account {
            lamports: f.svm.minimum_balance_for_rent_exemption(short.len()),
            data: short,
            owner: CLMM_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let p = Some((f.pool_a, f.pool_b));
    expect_crank_err(&mut f, slot, t, p, ERR_HALT_POOL_LAYOUT);

    // Pool B quoting a different mint pair.
    set_pools(&mut f, BENIGN, BENIGN);
    let other = clmm_pool_data(sqrt_x64_of(BENIGN), &Pubkey::new_unique(), &Pubkey::new_unique());
    f.svm.set_account(
        f.pool_b,
        Account {
            lamports: f.svm.minimum_balance_for_rent_exemption(other.len()),
            data: other,
            owner: CLMM_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let p = Some((f.pool_a, f.pool_b));
    expect_crank_err(&mut f, slot, t, p, ERR_HALT_POOL_LAYOUT);

    // Zero price.
    set_pools_raw(&mut f.svm, &f.pool_a, &f.pool_b, &f.mint_a, &f.mint_b, 0, BENIGN);
    let p = Some((f.pool_a, f.pool_b));
    expect_crank_err(&mut f, slot, t, p, ERR_HALT_POOL_PRICE);

    // Accounts passed in swapped slots (A slot carries pool B's key).
    set_pools(&mut f, BENIGN, BENIGN);
    let swapped = Some((f.pool_b, f.pool_a));
    expect_crank_err(&mut f, slot, t, swapped, ERR_HALT_POOL_MISMATCH);

    // Only one of the two pool slots provided.
    set_clock(&mut f.svm, slot, t);
    let mut ix = crank_ix(&f.cranker, Some((f.pool_a, f.pool_b)), None);
    ix.accounts[8].pubkey = solana_sdk::system_program::id(); // drop pool B
    let e = send(&mut f.svm, ix, &f.intruder, &[&f.cranker]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_HALT_POOLS_REQUIRED))
    );
}

#[test]
fn legacy_halt_state_migrates_in_place() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();

    // Plant a 32-byte pre-SPYx halt_state carrying a captured reference.
    let mut d = vec![0u8; HALT_STATE_SPACE_V1];
    d[..8].copy_from_slice(&DISC_HALT_STATE);
    d[8..16].copy_from_slice(&123_456i64.to_le_bytes());
    d[16..20].copy_from_slice(&100u32.to_le_bytes());
    f.svm.set_account(
        halt_key(),
        Account {
            lamports: f.svm.minimum_balance_for_rent_exemption(HALT_STATE_SPACE_V1),
            data: d,
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Any crank migrates it (payer covers the rent delta).
    set_clock(&mut f.svm, 100, et(2026, 9, 21, 3, 0));
    send(&mut f.svm, crank_ix(&f.cranker, None, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(f.svm.get_account(&halt_key()).unwrap().data.len(), HALT_STATE_SPACE as usize);
    let h = read_halt(&f.svm);
    assert_eq!((h.ref_price, h.ref_day, h.pending_since, h.pending_level), (123_456, 100, 0, 0));
}

#[test]
fn breaker_stands_without_a_reference_close() {
    let mut f = setup_with(true);
    send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
    set_clock(&mut f.svm, 100, et(2026, 9, 22, 9, 31));
    // No prior-close reference captured yet ⇒ the breaker stands regardless
    // of how deep the pool prices are (the venues are constants now).
    set_pools(&mut f, L3, L3);
    let p = Some((f.pool_a, f.pool_b));
    send(&mut f.svm, crank_ix(&f.cranker, p, None), &f.intruder, &[&f.cranker]).unwrap();
    assert_eq!(read_market(&f.svm).state, 0, "no reference ⇒ no halt");
}

// ─────────────────────────── on-chain: bounty config ────────────────────────

#[test]
fn fund_and_set_bounty_authority_gates() {
    let mut f = setup();
    let mut args = Vec::new();
    args.extend_from_slice(&1_000_000u64.to_le_bytes());
    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(f.intruder.pubkey(), true),
            AccountMeta::new_readonly(cfg_key(), false),
            AccountMeta::new(vault_key(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: [DISC_FUND_BOUNTY.to_vec(), args].concat(),
    };
    let e = send(&mut f.svm, ix, &f.intruder, &[]).unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_AUTHORITY))
    );
    send(&mut f.svm, fund_ix(&f.authority, 2_000_000), &f.authority, &[]).unwrap();
    assert!(f.svm.get_account(&vault_key()).unwrap().lamports > 2_000_000);

    let mut args = Vec::new();
    args.extend_from_slice(&25_000_000u64.to_le_bytes());
    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(f.authority.pubkey(), true),
            AccountMeta::new(cfg_key(), false),
        ],
        data: [DISC_SET_BOUNTY_AMOUNT.to_vec(), args].concat(),
    };
    send(&mut f.svm, ix, &f.authority, &[]).unwrap();
    assert_eq!(read_cfg(&f.svm).bounty_amount, 25_000_000);
}

#[test]
fn legacy_config_migrates_authority_gated() {
    let mut svm = svm_with_program();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 5_000_000_000).unwrap();

    let init_state = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(market_key(), false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: DISC_INITIALIZE_STATE.to_vec(),
    };
    send(&mut svm, init_state, &authority, &[]).unwrap();
    send(&mut svm, init_calendar_ix(&authority.pubkey(), &default_calendar()), &authority, &[]).unwrap();

    // Hand-craft the legacy 165-byte config.
    let legacy_space = 165usize;
    let mut data = vec![0u8; legacy_space];
    data[..8].copy_from_slice(&DISC_BOUNTY_CONFIG);
    data[8..40].copy_from_slice(authority.pubkey().as_ref());
    data[40..48].copy_from_slice(&10_000_000u64.to_le_bytes());
    data[48..56].copy_from_slice(&750_000u64.to_le_bytes());
    data[56..58].copy_from_slice(&2026u16.to_le_bytes());
    data[58..60].copy_from_slice(&500u16.to_le_bytes());
    data[60..68].copy_from_slice(&777u64.to_le_bytes());
    data[164] = Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).1;
    svm.set_account(
        cfg_key(),
        Account { lamports: svm.minimum_balance_for_rent_exemption(legacy_space), data, owner: ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();
    svm.set_account(
        vault_key(),
        Account { lamports: svm.minimum_balance_for_rent_exemption(1), data: vec![0u8; 1], owner: ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();

    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 5_000_000_000).unwrap();
    let e = send(
        &mut svm,
        init_bounty_ix(&intruder.pubkey(), 10_000_000, Pubkey::default(), Pubkey::default(), Pubkey::default()),
        &intruder,
        &[],
    )
    .unwrap_err();
    assert_eq!(
        e.err,
        TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_AUTHORITY))
    );

    send(
        &mut svm,
        init_bounty_ix(&authority.pubkey(), 10_000_000, Pubkey::default(), Pubkey::default(), Pubkey::default()),
        &authority,
        &[],
    )
    .unwrap();
    let cfg_acct = svm.get_account(&cfg_key()).unwrap();
    assert_eq!(cfg_acct.data.len(), BOUNTY_CONFIG_SPACE as usize);
    let c = read_cfg(&svm);
    assert_eq!(c.authority, authority.pubkey());
    assert_eq!(c.last_crank_slot, 777, "replay guard preserved across migration");

    send(&mut svm, fund_ix(&authority, 100_000_000), &authority, &[]).unwrap();
    set_clock(&mut svm, 800, et(2026, 9, 22, 9, 31));
    send(&mut svm, crank_ix(&authority, None, None), &intruder, &[&authority]).unwrap();
    assert_eq!(read_market(&svm).state, 0);
}

// ───────────────────────────── the wire contract ────────────────────────────

#[test]
fn idl_discriminators_match() {
    let idl_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/idl/crank_oracle.json");
    let idl: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&idl_path)
            .unwrap_or_else(|_| panic!("missing {} — run `anchor build` first", idl_path.display())),
    )
    .unwrap();

    let ix_discs: [(&str, [u8; 8]); 13] = [
        ("initialize_bounty", DISC_INITIALIZE_BOUNTY),
        ("fund_bounty", DISC_FUND_BOUNTY),
        ("permissionless_crank", DISC_PERMISSIONLESS_CRANK),
        ("read_oracle_data", DISC_READ_ORACLE_DATA),
        ("initialize_state", DISC_INITIALIZE_STATE),
        ("set_authority", DISC_SET_AUTHORITY),
        ("set_bounty_amount", DISC_SET_BOUNTY_AMOUNT),
        ("set_bounty_usd", DISC_SET_BOUNTY_USD),
        ("initialize_calendar", DISC_INITIALIZE_CALENDAR),
        ("set_timezone", DISC_SET_TIMEZONE),
        ("set_holidays", DISC_SET_HOLIDAYS),
        ("set_calendar_authority", DISC_SET_CALENDAR_AUTHORITY),
        ("set_halt_pools", DISC_SET_HALT_POOLS),
    ];
    for ix in idl["instructions"].as_array().unwrap() {
        let name = ix["name"].as_str().unwrap();
        let disc: Vec<u8> = ix["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let expected = ix_discs
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("instruction {name} not in the native dispatch"))
            .1;
        assert_eq!(disc.as_slice(), &expected, "instruction discriminator drift: {name}");
    }

    let acct_discs: [(&str, [u8; 8]); 4] = [
        ("BountyConfig", DISC_BOUNTY_CONFIG),
        ("MarketStatus", DISC_MARKET_STATUS),
        ("MarketCalendar", DISC_MARKET_CALENDAR),
        ("HaltState", DISC_HALT_STATE),
    ];
    for a in idl["accounts"].as_array().unwrap() {
        let name = a["name"].as_str().unwrap();
        let disc: Vec<u8> = a["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let expected = acct_discs
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("account {name} not in the native layouts"))
            .1;
        assert_eq!(disc.as_slice(), &expected, "account discriminator drift: {name}");
    }

    for e in idl["errors"].as_array().unwrap() {
        let code = e["code"].as_u64().unwrap() as u32;
        let name = e["name"].as_str().unwrap();
        let expected = match name {
            "NoFeeds" => ERR_NO_FEEDS,
            "InvalidFeedValue" => ERR_INVALID_FEED_VALUE,
            "InvalidMarketState" => ERR_INVALID_MARKET_STATE,
            "InvalidAuthority" => ERR_INVALID_AUTHORITY,
            "QuoteTooStale" => ERR_QUOTE_TOO_STALE,
            "StaleQuote" => ERR_STALE_QUOTE,
            "BountyExhausted" => ERR_BOUNTY_EXHAUSTED,
            "InvalidSolPrice" => ERR_INVALID_SOL_PRICE,
            "MathOverflow" => ERR_MATH_OVERFLOW,
            "UnpinnedOracleConfig" => ERR_UNPINNED_ORACLE_CONFIG,
            "QueueMismatch" => ERR_QUEUE_MISMATCH,
            "FeedNotPinned" => ERR_FEED_NOT_PINNED,
            "InvalidCalendarRule" => ERR_INVALID_CALENDAR_RULE,
            "CalendarPendingExists" => ERR_CALENDAR_PENDING_EXISTS,
            "InvalidCalendarData" => ERR_INVALID_CALENDAR_DATA,
            "HaltPoolsRequired" => ERR_HALT_POOLS_REQUIRED,
            "HaltPoolLayout" => ERR_HALT_POOL_LAYOUT,
            "HaltPoolMismatch" => ERR_HALT_POOL_MISMATCH,
            "InvalidHaltPoolPrice" => ERR_HALT_POOL_PRICE,
            "InvalidHaltPins" => ERR_HALT_POOL_PIN,
            other => panic!("error {other} not in the native error codes"),
        };
        assert_eq!(code, expected, "error code drift: {name}");
    }
}
