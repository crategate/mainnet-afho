//! Instruction handlers.
//!
//! The two crank paths share `apply_crank`, the transition engine: derive
//! the expected state from the calendar PDA + clock, activate any pending
//! calendar update at the first observed bell, overlay the circuit breaker,
//! and apply the transition (trading-day rollover, exact bell timestamp,
//! per-slot replay guard). `permissionless_crank` pays the bounty on real
//! transitions; `read_oracle_data` is the calendar-only no-pay variant.

use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, msg,
    program::invoke, program_error::ProgramError, pubkey::Pubkey, rent::Rent,
    system_instruction, sysvar::Sysvar,
};

use crate::bounty::{bounty_lamports, pay_bounty, vault_rent_floor};
use crate::calendar::{eval_state, last_boundary, validate_calendar_data, CalendarData};
use crate::constants::*;
use crate::halt::{apply_breaker, is_clmm_program, read_halt_pools};
use crate::state::*;

// ───────────────────────────── shared helpers ───────────────────────────────

pub fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: u64,
    signer_seeds: &[&[u8]],
) -> Result<(), ProgramError> {
    let lamports = Rent::get()?.minimum_balance(space as usize);
    // solana-system-interface marks the `to` account as a SIGNER meta (Agave
    // 2.2+ PDA creation hardening), so PDA creates must be invoke_signed
    // with the target's seeds — plain invoke fails with PrivilegeEscalation.
    solana_program::program::invoke_signed(
        &system_instruction::create_account(payer.key, target.key, lamports, space, &ID),
        &[payer.clone(), target.clone(), system.clone()],
        &[signer_seeds],
    )
}

pub fn require_signer(ai: &AccountInfo) -> Result<(), ProgramError> {
    if !ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

pub fn require_key(ai: &AccountInfo, key: &Pubkey) -> Result<(), ProgramError> {
    if ai.key != key {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn canonical_pda(seed: &[u8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seed], &ID)
}

/// anchor `seeds = [seed], bump = <stored bump>` — derive with the stored
/// bump (create_program_address rejects non-canonical bumps, same as anchor).
fn check_pda_stored(ai: &AccountInfo, seed: &[u8], bump: u8) -> Result<(), ProgramError> {
    let key = Pubkey::create_program_address(&[seed, &[bump]], &ID)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if ai.key != &key {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

fn check_pda_canonical(ai: &AccountInfo, seed: &[u8]) -> Result<(), ProgramError> {
    let (key, _) = canonical_pda(seed);
    if ai.key != &key {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

// arg decoding
fn take<const N: usize>(b: &mut &[u8]) -> Result<[u8; N], ProgramError> {
    if b.len() < N {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (head, rest) = b.split_at(N);
    *b = rest;
    Ok(head.try_into().unwrap())
}

fn finish(b: &[u8]) -> Result<(), ProgramError> {
    if b.is_empty() {
        Ok(())
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

fn arg_u64(b: &mut &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(take(b)?))
}
fn arg_u16(b: &mut &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(take(b)?))
}
fn arg_pubkey(b: &mut &[u8]) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(take(b)?))
}

/// Lazily initialize the halt_state PDA (cranker funds the rent; ~0.0002
/// SOL once, and the first transition bounty more than covers it). A 32-byte
/// account is the pre-SPYx layout (pending fields added 2026-09-20): it is
/// migrated in place — payer funds the rent delta — so old devnet accounts
/// keep cranking.
fn ensure_halt_state<'a>(
    ai: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
) -> Result<(), ProgramError> {
    if ai.data_is_empty() && ai.lamports() == 0 {
        check_pda_canonical(ai, SEED_HALT_STATE)?;
        let (_, bump) = canonical_pda(SEED_HALT_STATE);
        create_pda_account(payer, ai, system, HALT_STATE_SPACE, &[SEED_HALT_STATE, &[bump]])?;
        write_halt_state(
            ai,
            &HaltState {
                ref_price: 0,
                ref_day: 0,
                halt_until: 0,
                l3_day: 0,
                pending_since: 0,
                pending_level: 0,
            },
        )?;
        return Ok(());
    }
    if ai.data_len() == HALT_STATE_SPACE_V1 {
        check_pda_canonical(ai, SEED_HALT_STATE)?;
        let data = ai.try_borrow_data()?;
        let legacy = HaltState {
            ref_price: i64::from_le_bytes(data[8..16].try_into().unwrap()),
            ref_day: u32::from_le_bytes(data[16..20].try_into().unwrap()),
            halt_until: i64::from_le_bytes(data[20..28].try_into().unwrap()),
            l3_day: u32::from_le_bytes(data[28..32].try_into().unwrap()),
            pending_since: 0,
            pending_level: 0,
        };
        drop(data);
        let rent = Rent::get()?.minimum_balance(HALT_STATE_SPACE as usize);
        let deficit = rent.saturating_sub(ai.lamports());
        ai.realloc(HALT_STATE_SPACE as usize, false)?;
        if deficit > 0 {
            invoke(
                &system_instruction::transfer(payer.key, ai.key, deficit),
                &[payer.clone(), ai.clone(), system.clone()],
            )?;
        }
        write_halt_state(ai, &legacy)?;
    }
    Ok(())
}

// ──────────────────────────── the crank engine ──────────────────────────────

pub struct CrankOutcome {
    pub old_state: u8,
    pub new_state: u8,
    pub bell_ts: i64,
}

/// Shared transition engine for both crank paths.
///
/// `pool_a`/`pool_b`/`halt_ai` are the circuit-breaker accounts
/// (permissionless_crank only; read_oracle_data passes None and stays
/// calendar-only so the no-pay path can never touch halt state).
fn apply_crank(
    cfg_ai: &AccountInfo,
    market_ai: &AccountInfo,
    calendar_ai: &AccountInfo,
    pool_a: Option<&AccountInfo>,
    pool_b: Option<&AccountInfo>,
    halt_ai: Option<&AccountInfo>,
) -> Result<CrankOutcome, ProgramError> {
    let cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    check_pda_canonical(market_ai, SEED_MARKET_STATUS)?;
    check_pda_canonical(calendar_ai, SEED_MARKET_CALENDAR)?;

    let mut cal = read_market_calendar(calendar_ai)?;
    let clock = Clock::get()?;
    // Per-slot replay guard: each crank consumes its slot; the same or an
    // older slot is rejected.
    if clock.slot <= cfg.last_crank_slot {
        return Err(ProgramError::Custom(ERR_STALE_QUOTE));
    }

    let mut market = read_market_status(market_ai)?;
    let old_state = market.state;
    let mut cal_expected = eval_state(&cal.active, clock.unix_timestamp);

    // Pending calendar updates activate at the first observed bell — a
    // crank that sees a transition under the ACTIVE schedule swaps in the
    // pending data and re-derives under the new schedule.
    if cal.has_pending && cal_expected != old_state {
        cal.active = cal.pending;
        cal.has_pending = false;
        cal.pending_schedule = false;
        cal.pending_holidays = false;
        write_market_calendar(calendar_ai, &cal)?;
        msg!("pending calendar v{} activated at the bell", cal.active.version);
        cal_expected = eval_state(&cal.active, clock.unix_timestamp);
    }

    // Circuit breaker overlay (permissionless path only). Venues are pinned in
    // BountyConfig (the verified mainnet pair by default; re-pointed by the
    // calendar authority via `set_halt_pools` on a venue rotation). Both zero =
    // the breaker is inert (fail-open).
    let mut expected = cal_expected;
    if let Some(halt_ai) = halt_ai {
        check_pda_canonical(halt_ai, SEED_HALT_STATE)?;
        let mut halt = read_halt_state(halt_ai)?;
        let pinned = cfg.halt_pool_a != Pubkey::default();
        if pinned {
            // Pools are validated against the pins when passed; absent pools
            // leave the breaker inert (fail-open), so a keeper can still crank
            // the calendar without venue access.
            let pools = read_halt_pools(pool_a, pool_b, &cfg.halt_pool_a, &cfg.halt_pool_b)?;
            expected = apply_breaker(
                cal_expected,
                old_state,
                &mut halt,
                pools,
                &cal.active,
                clock.unix_timestamp,
            );
            write_halt_state(halt_ai, &halt)?;
        }
    }

    if expected > 3 {
        return Err(ProgramError::Custom(ERR_INVALID_MARKET_STATE)); // unreachable: calendar validates to {0,1}, breaker to {2,3}
    }

    // Day rolls at the OPEN bell ((1|2)→0: extended or closed → regular):
    // trading day N begins at its 9:30 open, so the index increments there
    // — the morning calc_completed_offers + distribute run on the fresh index.
    if (old_state == 1 || old_state == 2) && expected == 0 {
        market.trading_day_index = market.trading_day_index.checked_add(1).unwrap();
        msg!("Trading day rolled at the open. Day index: {}", market.trading_day_index);
    }
    market.state = expected;

    if expected == old_state {
        msg!("Heartbeat crank (no state change) — no bounty. State: {}", expected);
        let mut cfg_new = cfg;
        cfg_new.last_crank_slot = clock.slot;
        write_bounty_config(cfg_ai, &cfg_new)?;
        return Ok(CrankOutcome { old_state, new_state: expected, bell_ts: market.last_updated_timestamp });
    }

    // The timestamp marks when the CURRENT state began — the exact calendar
    // bell, not the crank landing (dex_buyback reads it as the market-open
    // time for its first-hour slice weighting). Breaker moments have no
    // calendar bell: they stamp `now`. Genesis (99 → state) has no history.
    market.last_updated_timestamp = if old_state == 99 || old_state == 3 || expected == 3 {
        clock.unix_timestamp
    } else {
        last_boundary(&cal.active, clock.unix_timestamp)
    };
    write_market_status(market_ai, &market)?;

    let mut cfg_new = cfg;
    cfg_new.last_crank_slot = clock.slot;
    write_bounty_config(cfg_ai, &cfg_new)?;

    Ok(CrankOutcome { old_state, new_state: expected, bell_ts: market.last_updated_timestamp })
}

// ──────────────────────────────── handlers ──────────────────────────────────

pub fn initialize_bounty(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, rest) = accounts.split_at(1);
    let (bounty_config_ai, rest) = rest.split_at(1);
    let (bounty_vault_ai, rest) = rest.split_at(1);
    let system = &rest[0];
    require_signer(&payer[0])?;
    require_key(system, &solana_program::system_program::id())?;

    let mut b = args;
    let bounty_amount = arg_u64(&mut b)?;
    let bounty_usd_raw = arg_u64(&mut b)?;
    let base_year = arg_u16(&mut b)?;
    let annual_inflation_bps = arg_u16(&mut b)?;
    let sol_usdc_pool = arg_pubkey(&mut b)?;
    let cpmm_program = arg_pubkey(&mut b)?;
    let usdc_mint = arg_pubkey(&mut b)?;
    finish(b)?;

    check_pda_canonical(&bounty_config_ai[0], SEED_BOUNTY_CONFIG)?;
    check_pda_canonical(&bounty_vault_ai[0], SEED_BOUNTY_VAULT)?;
    let (_, cfg_bump) = canonical_pda(SEED_BOUNTY_CONFIG);
    let (_, vault_bump) = canonical_pda(SEED_BOUNTY_VAULT);

    let make_cfg = |authority: Pubkey, last_crank_slot: u64| BountyConfig {
        authority,
        bounty_amount,
        bounty_usd_raw,
        base_year,
        annual_inflation_bps,
        last_crank_slot,
        sol_usdc_pool,
        cpmm_program,
        usdc_mint,
        bump: cfg_bump,
        // Armed from launch on mainnet: default to the verified SPYx pair.
        // Re-pointed by the calendar authority via `set_halt_pools`.
        halt_pool_a: HALT_POOL_A_MAINNET,
        halt_pool_b: HALT_POOL_B_MAINNET,
    };

    if bounty_config_ai[0].data_is_empty() {
        // Fresh deployment.
        create_pda_account(
            &payer[0],
            &bounty_config_ai[0],
            system,
            BOUNTY_CONFIG_SPACE,
            &[SEED_BOUNTY_CONFIG, &[cfg_bump]],
        )?;
    } else {
        // Existing account: refresh values for the recorded authority, growing
        // a legacy 165-byte layout in place (rent delta funded by the payer),
        // preserving `last_crank_slot` and any existing halt pins.
        let len = bounty_config_ai[0].data_len();
        let data = bounty_config_ai[0].try_borrow_data()?;
        if data[..8] != DISC_BOUNTY_CONFIG {
            return Err(ProgramError::InvalidAccountData);
        }
        let existing_authority = Pubkey::new_from_array(data[8..40].try_into().unwrap());
        let existing_slot = u64::from_le_bytes(data[60..68].try_into().unwrap());
        let (existing_a, existing_b) = if len >= BOUNTY_CONFIG_SPACE as usize {
            (
                Pubkey::new_from_array(data[165..197].try_into().unwrap()),
                Pubkey::new_from_array(data[197..229].try_into().unwrap()),
            )
        } else {
            (HALT_POOL_A_MAINNET, HALT_POOL_B_MAINNET)
        };
        drop(data);
        if payer[0].key != &existing_authority {
            return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
        }
        if len != BOUNTY_CONFIG_SPACE_LEGACY && len < BOUNTY_CONFIG_SPACE as usize {
            return Err(ProgramError::InvalidAccountData);
        }
        let rent = Rent::get()?.minimum_balance(BOUNTY_CONFIG_SPACE as usize);
        let deficit = rent.saturating_sub(bounty_config_ai[0].lamports());
        bounty_config_ai[0].realloc(BOUNTY_CONFIG_SPACE as usize, false)?;
        if deficit > 0 {
            invoke(
                &system_instruction::transfer(payer[0].key, bounty_config_ai[0].key, deficit),
                &[payer[0].clone(), bounty_config_ai[0].clone(), system.clone()],
            )?;
        }
        let mut refreshed = make_cfg(existing_authority, existing_slot);
        refreshed.halt_pool_a = existing_a;
        refreshed.halt_pool_b = existing_b;
        write_bounty_config(&bounty_config_ai[0], &refreshed)?;
        msg!("bounty_config refreshed (halt venues preserved)");
        if bounty_vault_ai[0].data_is_empty() && bounty_vault_ai[0].lamports() == 0 {
            create_pda_account(
                &payer[0],
                &bounty_vault_ai[0],
                system,
                1,
                &[SEED_BOUNTY_VAULT, &[vault_bump]],
            )?;
        }
        return Ok(());
    }

    if bounty_vault_ai[0].data_is_empty() && bounty_vault_ai[0].lamports() == 0 {
        create_pda_account(
            &payer[0],
            &bounty_vault_ai[0],
            system,
            1,
            &[SEED_BOUNTY_VAULT, &[vault_bump]],
        )?;
    }

    write_bounty_config(&bounty_config_ai[0], &make_cfg(*payer[0].key, 0))?;
    Ok(())
}

pub fn fund_bounty(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, rest) = accounts.split_at(1);
    let (cfg_ai, rest) = rest.split_at(1);
    let (vault_ai, rest) = rest.split_at(1);
    let system = &rest[0];
    require_signer(&payer[0])?;
    require_key(system, &solana_program::system_program::id())?;

    let mut b = args;
    let amount = arg_u64(&mut b)?;
    finish(b)?;

    let cfg = read_bounty_config(&cfg_ai[0])?;
    check_pda_stored(&cfg_ai[0], SEED_BOUNTY_CONFIG, cfg.bump)?;
    check_pda_canonical(&vault_ai[0], SEED_BOUNTY_VAULT)?;
    if payer[0].key != &cfg.authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    invoke(
        &system_instruction::transfer(payer[0].key, vault_ai[0].key, amount),
        &[payer[0].clone(), vault_ai[0].clone()],
    )?;
    Ok(())
}

pub fn permissionless_crank(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // cranker, bounty_config, bounty_vault, clock, market_status,
    // market_calendar, halt_state, halt_pool_a?, halt_pool_b?,
    // sol_usdc_wsol_vault?, sol_usdc_usdc_vault?, system_program
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let cranker = &accounts[0];
    let cfg_ai = &accounts[1];
    let vault_ai = &accounts[2];
    let clock_ai = &accounts[3];
    let market_ai = &accounts[4];
    let calendar_ai = &accounts[5];
    let halt_ai = &accounts[6];
    let pool_a_ai = &accounts[7];
    let pool_b_ai = &accounts[8];
    let system_ai = &accounts[accounts.len() - 1];
    let opt = &accounts[9..accounts.len() - 1];
    require_signer(cranker)?;
    require_key(clock_ai, &solana_program::sysvar::clock::id())?;
    require_key(system_ai, &solana_program::system_program::id())?;
    check_pda_canonical(vault_ai, SEED_BOUNTY_VAULT)?;

    ensure_halt_state(halt_ai, cranker, system_ai)?;
    // The pool slots are positional but optional: the system program key is
    // the canonical "not provided" placeholder (same convention as anchor
    // Option<AccountInfo>) — both, or neither.
    let sys = solana_program::system_program::id();
    let pools = match (pool_a_ai.key != &sys, pool_b_ai.key != &sys) {
        (true, true) => (Some(pool_a_ai), Some(pool_b_ai)),
        (false, false) => (None, None),
        _ => return Err(ProgramError::Custom(ERR_HALT_POOLS_REQUIRED)),
    };

    let outcome = apply_crank(cfg_ai, market_ai, calendar_ai, pools.0, pools.1, Some(halt_ai))?;
    if outcome.new_state == outcome.old_state {
        return Ok(()); // heartbeat — slot consumed, nothing paid
    }

    let cfg = read_bounty_config(cfg_ai)?;
    let bounty = bounty_lamports(&cfg, opt.first(), opt.get(1), Clock::get()?.unix_timestamp)?;
    if bounty == 0 {
        return Err(ProgramError::Custom(ERR_INVALID_SOL_PRICE));
    }
    if vault_ai.lamports() < bounty + vault_rent_floor()? {
        return Err(ProgramError::Custom(ERR_BOUNTY_EXHAUSTED));
    }

    pay_bounty(vault_ai, cranker, bounty)?;
    msg!(
        "Cranked by {}. Bounty paid: {} lamports. State: {} (bell {})",
        cranker.key,
        bounty,
        outcome.new_state,
        outcome.bell_ts
    );
    Ok(())
}

pub fn read_oracle_data(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // cranker, bounty_config, clock, market_status, market_calendar
    if accounts.len() != 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let cranker = &accounts[0];
    let cfg_ai = &accounts[1];
    let clock_ai = &accounts[2];
    let market_ai = &accounts[3];
    let calendar_ai = &accounts[4];
    require_signer(cranker)?;
    require_key(clock_ai, &solana_program::sysvar::clock::id())?;

    // Calendar-only by design: this path can burn a calendar transition
    // unpaid (accepted griefing) but can never declare or clear halts.
    let outcome = apply_crank(cfg_ai, market_ai, calendar_ai, None, None, None)?;
    msg!(
        "Market state: {} | Bell timestamp: {} | Transition: {} -> {}",
        outcome.new_state,
        outcome.bell_ts,
        outcome.old_state,
        outcome.new_state
    );
    Ok(())
}

pub fn initialize_state(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // market_status, payer, system_program
    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let market_ai = &accounts[0];
    let payer = &accounts[1];
    let system = &accounts[2];
    require_signer(payer)?;
    require_key(system, &solana_program::system_program::id())?;
    check_pda_canonical(market_ai, SEED_MARKET_STATUS)?;
    let (_, market_bump) = canonical_pda(SEED_MARKET_STATUS);

    create_pda_account(payer, market_ai, system, 40, &[SEED_MARKET_STATUS, &[market_bump]])?;
    write_market_status(
        market_ai,
        &MarketStatus {
            state: 99, // fail-closed sentinel (documented in AGENTS.md)
            last_updated_timestamp: 0,
            trading_day_index: 0,
        },
    )?;
    Ok(())
}

/// market_calendar, payer, system_program + a full CalendarData arg.
pub fn initialize_calendar(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let calendar_ai = &accounts[0];
    let payer = &accounts[1];
    let system = &accounts[2];
    require_signer(payer)?;
    require_key(system, &solana_program::system_program::id())?;
    check_pda_canonical(calendar_ai, SEED_MARKET_CALENDAR)?;
    if !calendar_ai.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let mut data = crate::calendar::calendar_data_from_bytes(args)?;
    finish(&args[crate::calendar::CALENDAR_DATA_SPACE..])?;
    data.version = 1;
    validate_calendar_data(&data)?;
    let (_, bump) = canonical_pda(SEED_MARKET_CALENDAR);
    create_pda_account(
        payer,
        calendar_ai,
        system,
        MARKET_CALENDAR_SPACE,
        &[SEED_MARKET_CALENDAR, &[bump]],
    )?;
    write_market_calendar(
        calendar_ai,
        &MarketCalendar {
            calendar_authority: *payer.key,
            active: data,
            has_pending: false,
            pending_schedule: false,
            pending_holidays: false,
            pending: CalendarData::default(),
        },
    )?;
    msg!(
        "market_calendar initialized (v1, {} rules, {} overrides; payer holds the calendar authority)",
        data.rule_count,
        data.override_count
    );
    Ok(())
}

/// authority, market_calendar + the 14-byte tz/DST part. THE TIMEZONE KNOB:
/// adjusts only the ET offset/DST rule (e.g. a permanent US DST policy
/// change). The session times are frozen. Queued; activates at the next bell.
pub fn set_timezone(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let calendar_ai = &accounts[1];
    require_signer(authority)?;
    check_pda_canonical(calendar_ai, SEED_MARKET_CALENDAR)?;
    let mut cal = read_market_calendar(calendar_ai)?;
    queue_timezone(&mut cal, args, authority.key, Clock::get()?.unix_timestamp)?;
    write_market_calendar(calendar_ai, &cal)?;
    msg!(
        "calendar timezone queued (v{}) — activates at the next bell",
        cal.pending.version
    );
    Ok(())
}

/// authority, market_calendar + the 201-byte holidays part. THE HOLIDAY KNOB:
/// closures + half-days — fail-safe-only data (can close/shorten a session,
/// never open one off-schedule).
pub fn set_holidays(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let calendar_ai = &accounts[1];
    require_signer(authority)?;
    check_pda_canonical(calendar_ai, SEED_MARKET_CALENDAR)?;
    let mut cal = read_market_calendar(calendar_ai)?;
    queue_holidays(&mut cal, args, authority.key, Clock::get()?.unix_timestamp)?;
    write_market_calendar(calendar_ai, &cal)?;
    msg!(
        "calendar holidays queued (v{}) — activates at the next bell",
        cal.pending.version
    );
    Ok(())
}

/// Rotate the calendar authority (the Squads multisig that owns the tz/DST
/// and holiday knobs). Rotating to `11111111111111111111111111111111` (the
/// burn address) FREEZES the mutable calendar data permanently — see
/// docs/AUTHORITY-PLAYBOOK.md.
pub fn set_calendar_authority(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let calendar_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_authority = arg_pubkey(&mut b)?;
    finish(b)?;

    let mut cal = read_market_calendar(calendar_ai)?;
    check_pda_canonical(calendar_ai, SEED_MARKET_CALENDAR)?;
    if authority.key != &cal.calendar_authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    cal.calendar_authority = new_authority;
    write_market_calendar(calendar_ai, &cal)?;
    msg!("market_calendar authority rotated to: {}", new_authority);
    Ok(())
}

/// calendar authority, market_calendar + bounty_config + two Raydium CLMM pool
/// pubkeys + the two pool ACCOUNTS. Re-points the circuit-breaker venues — a
/// MAINTENANCE knob gated by the calendar authority. Two zero pubkeys leave
/// the breaker inert (fail-open); a valid pair must be distinct + non-zero,
/// each pool account must match its pin AND be owned by a Raydium CLMM
/// program (refuses arbitrary pubkeys / non-CLMM programs at pin time). Halt
/// DETECTION stays fully automatic: this can never trigger or extend a halt,
/// and through genuine venues it cannot fabricate one (halts move no funds).
pub fn set_halt_pools(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let calendar_ai = &accounts[1];
    let cfg_ai = &accounts[2];
    let pool_a_ai = &accounts[3];
    let pool_b_ai = &accounts[4];
    require_signer(authority)?;
    check_pda_canonical(calendar_ai, SEED_MARKET_CALENDAR)?;

    let mut b = args;
    let pool_a = arg_pubkey(&mut b)?;
    let pool_b = arg_pubkey(&mut b)?;
    finish(b)?;

    let disable = pool_a == Pubkey::default() && pool_b == Pubkey::default();
    if !disable
        && (pool_a == Pubkey::default() || pool_b == Pubkey::default() || pool_a == pool_b)
    {
        return Err(ProgramError::Custom(ERR_HALT_POOL_PIN));
    }
    let cal = read_market_calendar(calendar_ai)?;
    if authority.key != &cal.calendar_authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    // Pin-time ownership proof: the passed accounts must be the named pools
    // and live under a Raydium CLMM program (skipped when clearing — the
    // disable path passes filler accounts).
    if !disable {
        for (ai, pinned) in [(pool_a_ai, &pool_a), (pool_b_ai, &pool_b)] {
            if ai.key != pinned {
                return Err(ProgramError::Custom(ERR_HALT_POOL_MISMATCH));
            }
            if !is_clmm_program(ai.owner) {
                return Err(ProgramError::Custom(ERR_HALT_POOL_OWNER));
            }
        }
    }
    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    cfg.halt_pool_a = pool_a;
    cfg.halt_pool_b = pool_b;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!(
        "circuit-breaker venues {}: a {} b {}",
        if disable { "cleared (breaker inert)" } else { "re-pointed" },
        pool_a,
        pool_b
    );
    Ok(())
}

pub fn set_authority(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let cfg_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_authority = arg_pubkey(&mut b)?;
    finish(b)?;

    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    if authority.key != &cfg.authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    cfg.authority = new_authority;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!("Bounty authority rotated to: {}", new_authority);
    Ok(())
}

pub fn set_bounty_amount(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let cfg_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_amount = arg_u64(&mut b)?;
    finish(b)?;

    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    if authority.key != &cfg.authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    cfg.bounty_amount = new_amount;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!("Bounty fallback amount set to: {}", new_amount);
    Ok(())
}

pub fn set_bounty_usd(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let cfg_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_usd_raw = arg_u64(&mut b)?;
    finish(b)?;

    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    if authority.key != &cfg.authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    cfg.bounty_usd_raw = new_usd_raw;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!("USD bounty set to {} usdc raw", new_usd_raw);
    Ok(())
}
