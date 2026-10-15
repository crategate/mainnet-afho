//! Frozen on-chain account layouts + native read/write codecs.
//!
//! Every layout is byte-identical to the anchor borsh layout in
//! `idl_spec.rs` (8-byte discriminator + fixed-size LE fields, no padding).
//! `BountyConfig` offsets are a cross-program contract — the amm program
//! reads `bounty_usd_raw` at 48..56 — so fields are append-only.

use solana_program::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey,
};

use crate::calendar::{
    apply_holidays_part, apply_timezone_part, calendar_data_from_bytes,
    calendar_data_to_bytes, validate_calendar_data, CalendarData, CALENDAR_DATA_SPACE,
    OVERRIDES_PART_SPACE, TIMEZONE_PART_SPACE,
};
use crate::constants::*;

// ───────────────────────────── market_status ───────────────────────────────
/// disc(8) + current_state(1) + last_updated_timestamp(8) + trading_day_index(8)
/// = 25 bytes (anchor allocates 40). Layout FROZEN — amm/staking read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketStatus {
    pub state: u8,
    pub last_updated_timestamp: i64,
    pub trading_day_index: u64,
}

pub fn read_market_status(ai: &AccountInfo) -> Result<MarketStatus, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < 25 || data[..8] != DISC_MARKET_STATUS {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(MarketStatus {
        state: data[8],
        last_updated_timestamp: i64::from_le_bytes(data[9..17].try_into().unwrap()),
        trading_day_index: u64::from_le_bytes(data[17..25].try_into().unwrap()),
    })
}

pub fn write_market_status(ai: &AccountInfo, m: &MarketStatus) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    if data.len() < 25 {
        return Err(ProgramError::InvalidAccountData);
    }
    data[..8].copy_from_slice(&DISC_MARKET_STATUS);
    data[8] = m.state;
    data[9..17].copy_from_slice(&m.last_updated_timestamp.to_le_bytes());
    data[17..25].copy_from_slice(&m.trading_day_index.to_le_bytes());
    Ok(())
}

// ───────────────────────────── bounty_config ───────────────────────────────
/// disc(8) + authority(32) + bounty_amount(8) + bounty_usd_raw(8)
/// + base_year(2) + annual_inflation_bps(2) + last_crank_slot(8)
/// + sol_usdc_pool(32) + cpmm_program(32) + usdc_mint(32) + bump(1)
/// + halt_pool_a(32) + halt_pool_b(32) = 229.
///
/// Offsets are a cross-program contract (amm reads `bounty_usd_raw` at
/// 48..56). `halt_pool_a`/`halt_pool_b` (165/197) are the circuit-breaker
/// SPYx/USDC venue pair; they DEFAULT to `HALT_POOL_*_MAINNET` at init and are
/// re-pointed by the calendar authority (Squads multisig) via `set_halt_pools`
/// for a Raydium/xStocks rotation. Both zero = breaker inert (fail-open).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BountyConfig {
    pub authority: Pubkey,
    pub bounty_amount: u64,
    pub bounty_usd_raw: u64,
    pub base_year: u16,
    pub annual_inflation_bps: u16,
    pub last_crank_slot: u64,
    pub sol_usdc_pool: Pubkey,
    pub cpmm_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
    pub halt_pool_a: Pubkey,
    pub halt_pool_b: Pubkey,
}

pub const BOUNTY_CONFIG_SPACE: u64 = 229;
/// Pre-2026-09-17 layout — recognized by the initialize_bounty in-place
/// upgrade path.
pub const BOUNTY_CONFIG_SPACE_LEGACY: usize = 165;

pub fn read_bounty_config(ai: &AccountInfo) -> Result<BountyConfig, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < BOUNTY_CONFIG_SPACE as usize || data[..8] != DISC_BOUNTY_CONFIG {
        return Err(ProgramError::InvalidAccountData);
    }
    let pk = |r: std::ops::Range<usize>| Pubkey::new_from_array(data[r].try_into().unwrap());
    Ok(BountyConfig {
        authority: pk(8..40),
        bounty_amount: u64::from_le_bytes(data[40..48].try_into().unwrap()),
        bounty_usd_raw: u64::from_le_bytes(data[48..56].try_into().unwrap()),
        base_year: u16::from_le_bytes(data[56..58].try_into().unwrap()),
        annual_inflation_bps: u16::from_le_bytes(data[58..60].try_into().unwrap()),
        last_crank_slot: u64::from_le_bytes(data[60..68].try_into().unwrap()),
        sol_usdc_pool: pk(68..100),
        cpmm_program: pk(100..132),
        usdc_mint: pk(132..164),
        bump: data[164],
        halt_pool_a: pk(165..197),
        halt_pool_b: pk(197..229),
    })
}

pub fn write_bounty_config(ai: &AccountInfo, c: &BountyConfig) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    if data.len() < BOUNTY_CONFIG_SPACE as usize {
        return Err(ProgramError::InvalidAccountData);
    }
    data[..8].copy_from_slice(&DISC_BOUNTY_CONFIG);
    data[8..40].copy_from_slice(c.authority.as_ref());
    data[40..48].copy_from_slice(&c.bounty_amount.to_le_bytes());
    data[48..56].copy_from_slice(&c.bounty_usd_raw.to_le_bytes());
    data[56..58].copy_from_slice(&c.base_year.to_le_bytes());
    data[58..60].copy_from_slice(&c.annual_inflation_bps.to_le_bytes());
    data[60..68].copy_from_slice(&c.last_crank_slot.to_le_bytes());
    data[68..100].copy_from_slice(c.sol_usdc_pool.as_ref());
    data[100..132].copy_from_slice(c.cpmm_program.as_ref());
    data[132..164].copy_from_slice(c.usdc_mint.as_ref());
    data[164] = c.bump;
    data[165..197].copy_from_slice(c.halt_pool_a.as_ref());
    data[197..229].copy_from_slice(c.halt_pool_b.as_ref());
    Ok(())
}

// ──────────────────────────── market_calendar ──────────────────────────────
/// disc(8) + calendar_authority(32) + active(278) + has_pending(1)
/// + pending_schedule(1) + pending_holidays(1) + pending(278) = 599.
///
/// The calendar authority (Squads multisig) holds the MUTABLE calendar data:
/// the tz/DST rule and the holiday/half-day overrides. The session RULES are
/// frozen at init (no production setter). Updates only activate at the next
/// bell. `pending_schedule` covers the tz/DST knob (and the devnet-only rules
/// setter); `pending_holidays` the override list.
pub const MARKET_CALENDAR_SPACE: u64 = 599;

#[derive(Clone, Copy, Debug)]
pub struct MarketCalendar {
    pub calendar_authority: Pubkey,
    pub active: CalendarData,
    pub has_pending: bool,
    pub pending_schedule: bool,
    pub pending_holidays: bool,
    pub pending: CalendarData,
}

pub fn read_market_calendar(ai: &AccountInfo) -> Result<MarketCalendar, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < MARKET_CALENDAR_SPACE as usize || data[..8] != DISC_MARKET_CALENDAR {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(MarketCalendar {
        calendar_authority: Pubkey::new_from_array(data[8..40].try_into().unwrap()),
        active: calendar_data_from_bytes(&data[40..40 + CALENDAR_DATA_SPACE])?,
        has_pending: data[40 + CALENDAR_DATA_SPACE] != 0,
        pending_schedule: data[41 + CALENDAR_DATA_SPACE] != 0,
        pending_holidays: data[42 + CALENDAR_DATA_SPACE] != 0,
        pending: calendar_data_from_bytes(
            &data[43 + CALENDAR_DATA_SPACE..43 + 2 * CALENDAR_DATA_SPACE],
        )?,
    })
}

pub fn write_market_calendar(ai: &AccountInfo, cal: &MarketCalendar) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    if data.len() < MARKET_CALENDAR_SPACE as usize {
        return Err(ProgramError::InvalidAccountData);
    }
    data[..8].copy_from_slice(&DISC_MARKET_CALENDAR);
    data[8..40].copy_from_slice(cal.calendar_authority.as_ref());
    let active = calendar_data_to_bytes(&cal.active);
    data[40..40 + CALENDAR_DATA_SPACE].copy_from_slice(&active);
    data[40 + CALENDAR_DATA_SPACE] = cal.has_pending as u8;
    data[41 + CALENDAR_DATA_SPACE] = cal.pending_schedule as u8;
    data[42 + CALENDAR_DATA_SPACE] = cal.pending_holidays as u8;
    let pending = calendar_data_to_bytes(&cal.pending);
    data[43 + CALENDAR_DATA_SPACE..43 + 2 * CALENDAR_DATA_SPACE].copy_from_slice(&pending);
    Ok(())
}

/// Queue a tz/DST (timezone) update into the pending block — gated by the
/// calendar authority. The session rules and holidays are left untouched.
pub fn queue_timezone(
    cal: &mut MarketCalendar,
    args: &[u8],
    signer: &Pubkey,
    now: i64,
) -> Result<(), ProgramError> {
    if signer != &cal.calendar_authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    if cal.pending_schedule {
        return Err(ProgramError::Custom(ERR_CALENDAR_PENDING_EXISTS));
    }
    let mut data = if cal.has_pending { cal.pending } else { cal.active };
    apply_timezone_part(&mut data, args)?;
    finish_after(args, TIMEZONE_PART_SPACE)?;
    commit_pending(cal, data, now, false)?;
    Ok(())
}

/// Queue a holiday/half-day (overrides) update — gated by the calendar
/// authority. The session rules and tz/DST are left untouched.
pub fn queue_holidays(
    cal: &mut MarketCalendar,
    args: &[u8],
    signer: &Pubkey,
    now: i64,
) -> Result<(), ProgramError> {
    if signer != &cal.calendar_authority {
        return Err(ProgramError::Custom(ERR_INVALID_AUTHORITY));
    }
    if cal.pending_holidays {
        return Err(ProgramError::Custom(ERR_CALENDAR_PENDING_EXISTS));
    }
    let mut data = if cal.has_pending { cal.pending } else { cal.active };
    apply_holidays_part(&mut data, args)?;
    finish_after(args, OVERRIDES_PART_SPACE)?;
    commit_pending(cal, data, now, true)?;
    Ok(())
}

/// Validate + install a queued pending block (activates at the next bell).
fn commit_pending(
    cal: &mut MarketCalendar,
    mut data: CalendarData,
    now: i64,
    holidays: bool,
) -> Result<(), ProgramError> {
    validate_calendar_data(&data)?;
    data.version = cal.active.version.wrapping_add(1);
    data.updated_at = now;
    cal.pending = data;
    cal.has_pending = true;
    if holidays {
        cal.pending_holidays = true;
    } else {
        cal.pending_schedule = true;
    }
    Ok(())
}

fn finish_after(args: &[u8], n: usize) -> Result<(), ProgramError> {
    if args.len() == n {
        Ok(())
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

// ─────────────────────────────── halt_state ────────────────────────────────
/// disc(8) + ref_price(8) + ref_day(4) + halt_until(8) + l3_day(4)
/// + pending_since(8) + pending_level(1) = 41.
///
/// Circuit-breaker bookkeeping: `ref_price` is the SPYx prior-close price
/// captured at the 16:00 ET bell from the pinned pool A (raw pool ratio —
/// exponent-free; only ratios against the same pool set are ever compared);
/// `halt_until` is a Level-1/2 halt overlay expiry (0 = none); `l3_day` is
/// the local day closed early by a Level-3 breaker (0 = never);
/// `pending_since`/`pending_level` arm the two-crank confirmation window
/// (0 = no pending breach).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HaltState {
    pub ref_price: i64,
    pub ref_day: u32,
    pub halt_until: i64,
    pub l3_day: u32,
    pub pending_since: i64,
    pub pending_level: u8,
}

pub const HALT_STATE_SPACE: u64 = 41;
/// Pre-2026-09-20 layout (no confirmation fields) — migrated in place.
pub const HALT_STATE_SPACE_V1: usize = 32;

pub fn read_halt_state(ai: &AccountInfo) -> Result<HaltState, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < HALT_STATE_SPACE as usize || data[..8] != DISC_HALT_STATE {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(HaltState {
        ref_price: i64::from_le_bytes(data[8..16].try_into().unwrap()),
        ref_day: u32::from_le_bytes(data[16..20].try_into().unwrap()),
        halt_until: i64::from_le_bytes(data[20..28].try_into().unwrap()),
        l3_day: u32::from_le_bytes(data[28..32].try_into().unwrap()),
        pending_since: i64::from_le_bytes(data[32..40].try_into().unwrap()),
        pending_level: data[40],
    })
}

pub fn write_halt_state(ai: &AccountInfo, h: &HaltState) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    if data.len() < HALT_STATE_SPACE as usize {
        return Err(ProgramError::InvalidAccountData);
    }
    data[..8].copy_from_slice(&DISC_HALT_STATE);
    data[8..16].copy_from_slice(&h.ref_price.to_le_bytes());
    data[16..20].copy_from_slice(&h.ref_day.to_le_bytes());
    data[20..28].copy_from_slice(&h.halt_until.to_le_bytes());
    data[28..32].copy_from_slice(&h.l3_day.to_le_bytes());
    data[32..40].copy_from_slice(&h.pending_since.to_le_bytes());
    data[40] = h.pending_level;
    Ok(())
}
