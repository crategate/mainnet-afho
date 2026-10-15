//! The circuit-breaker layer: NYSE Rule 7.12 computed on-chain from the
//! tokenized S&P (SPYx, the xStocks SPL token) trading on Raydium.
//!
//! Rule 7.12 (market-wide trading halts), as specified — decline vs the PRIOR
//! DAY'S CLOSE of:
//!   • 7% (Level 1) or 13% (Level 2), before 15:25 ET → 15-minute halt;
//!   • 13% (Level 2) at or after 15:25 ET → close for the day;
//!   • 20% (Level 3), any time → close for the day.
//!
//! Price source: TWO pinned Raydium CLMM pools (independent SPYx/USDC venues)
//! — the market IS the oracle. A halt requires the threshold breach on BOTH
//! pools, held across two cranks ≥ `CONFIRM_WINDOW_SECS` apart (real crashes
//! persist; wicks don't). Venues are pinned in `BountyConfig` and re-pointed
//! by the calendar authority via `set_halt_pools` — a maintenance knob, never
//! a halt override.
//!
//! Fail-open by design: no pools passed, a stale/unavailable reference, or a
//! missed capture leaves the desk running on the calendar alone.

use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::calendar::{local_day_sod, CalendarData};
use crate::constants::*;
use crate::state::HaltState;

/// Raydium CLMM `PoolState` wire layout (packed borsh, per the SDK's
/// `PoolInfoLayout`): disc(8) bump(1) config(32) creator(32) mintA(32)
/// mintB(32) vaultA(32) vaultB(32) observation(32) decimalsA(1) decimalsB(1)
/// tickSpacing(2) liquidity(16) sqrtPriceX64(16) tickCurrent(4)… = 1544.
/// The mint/decimal reads double as layout canaries: a shifted or foreign
/// account fails `ERR_HALT_POOL_LAYOUT` instead of yielding a wrong price.
pub const CLMM_POOL_SPACE: usize = 1544;
pub const CLMM_OFF_MINT_A: usize = 73;
pub const CLMM_OFF_MINT_B: usize = 105;
pub const CLMM_OFF_DECIMALS: usize = 233;
pub const CLMM_OFF_SQRT_PRICE: usize = 253;

/// A breach must hold on both pools across two cranks this far apart before
/// the breaker acts — the anti-wick / anti-manipulation window. A sighting
/// older than `PENDING_MAX_SPAN_SECS` re-arms instead of confirming, so a
/// pending state can never leak across sessions.
pub const CONFIRM_WINDOW_SECS: i64 = 60;
pub const PENDING_MAX_SPAN_SECS: i64 = 600;

pub(crate) fn is_clmm_program(owner: &Pubkey) -> bool {
    owner == &CLMM_PROGRAM_ID
}

/// Validate one pinned pool account and return its price as a raw ratio
/// (`(sqrt_price_x64²) >> 64` — token-B per token-A in equal-decimal atoms;
/// orientation-agnostic, since reference and live always come from the same
/// pinned venue pair).
fn read_pool_price(ai: &AccountInfo, pinned: &Pubkey) -> Result<i64, ProgramError> {
    if ai.key != pinned {
        return Err(ProgramError::Custom(ERR_HALT_POOL_MISMATCH));
    }
    if !is_clmm_program(ai.owner) {
        return Err(ProgramError::Custom(ERR_HALT_POOL_LAYOUT));
    }
    let data = ai.try_borrow_data()?;
    if data.len() != CLMM_POOL_SPACE {
        return Err(ProgramError::Custom(ERR_HALT_POOL_LAYOUT));
    }
    if data[CLMM_OFF_DECIMALS] != data[CLMM_OFF_DECIMALS + 1] {
        // Equal decimals make the raw ratio scale-free; SPYx/USDC is 6/6.
        return Err(ProgramError::Custom(ERR_HALT_POOL_LAYOUT));
    }
    let sqrt = u128::from_le_bytes(
        data[CLMM_OFF_SQRT_PRICE..CLMM_OFF_SQRT_PRICE + 16].try_into().unwrap(),
    );
    // sqrt ≤ 2^64 keeps sqrt² inside u128; the squared ratio must fit i64.
    let price = if sqrt == 0 || sqrt > u64::MAX as u128 {
        return Err(ProgramError::Custom(ERR_HALT_POOL_PRICE));
    } else {
        (sqrt * sqrt) >> 64
    };
    if price == 0 || price > i64::MAX as u128 {
        return Err(ProgramError::Custom(ERR_HALT_POOL_PRICE));
    }
    Ok(price as i64)
}

/// Read + validate the pinned pool pair. `Ok(None)` = no accounts passed.
/// Both pools must be owned by the SAME CLMM venue program, carry the SAME
/// mint pair (cross-venue canary) and the same scale, so a reference captured
/// from one venue compares cleanly against the other. Each passed account
/// must match its pinned key — the pins are the spoofing guard.
pub fn read_halt_pools(
    a: Option<&AccountInfo>,
    b: Option<&AccountInfo>,
    pin_a: &Pubkey,
    pin_b: &Pubkey,
) -> Result<Option<(i64, i64)>, ProgramError> {
    match (a, b) {
        (None, None) => Ok(None),
        (Some(pa), Some(pb)) => {
            let price_a = read_pool_price(pa, pin_a)?;
            let price_b = read_pool_price(pb, pin_b)?;
            let da = pa.try_borrow_data()?;
            let db = pb.try_borrow_data()?;
            let mints_equal = da[CLMM_OFF_MINT_A..CLMM_OFF_MINT_A + 32]
                == db[CLMM_OFF_MINT_A..CLMM_OFF_MINT_A + 32]
                && da[CLMM_OFF_MINT_B..CLMM_OFF_MINT_B + 32]
                    == db[CLMM_OFF_MINT_B..CLMM_OFF_MINT_B + 32]
                    && da[CLMM_OFF_DECIMALS] == db[CLMM_OFF_DECIMALS];
            if !mints_equal {
                return Err(ProgramError::Custom(ERR_HALT_POOL_LAYOUT));
            }
            Ok(Some((price_a, price_b)))
        }
        // Half-provided pairs can never satisfy the both-pools rule.
        _ => Err(ProgramError::Custom(ERR_HALT_POOLS_REQUIRED)),
    }
}

/// Rule 7.12 thresholds in basis points of the prior close, and the halt
/// duration / late-session cutoff.
pub const L1_BPS: i128 = 700;
pub const L2_BPS: i128 = 1_300;
pub const L3_BPS: i128 = 2_000;
pub const HALT_DURATION_SECS: i64 = 15 * 60;
/// 15:25 ET in local minutes-of-day — L1/L2 halts only before this; at or
/// after, a Level-2 decline closes the day.
pub const L2_CUTOFF_MIN: i64 = 15 * 60 + 25;
/// A reference close is valid for this many local days (Friday's close
/// covers Monday; holidays stretch the gap — beyond this the breaker is
/// inert rather than acting on a stale reference).
pub const REF_MAX_AGE_DAYS: i64 = 5;

/// Severity of a single price against the stored reference:
/// 0 = stand, 1 = Level-1/2 halt territory, 2 = close-for-day territory.
/// Ratio math is scale-free: reference and live come from the same pinned
/// pool pair, so raw pool ratios compare directly.
fn breach_level(halt: &HaltState, price: i64, cal: &CalendarData, now: i64) -> u8 {
    if halt.ref_price <= 0 || price <= 0 {
        return 0; // no (or nonsensical) reference
    }
    let (today, sod) = local_day_sod(cal, now);
    let age = today - halt.ref_day as i64;
    if age < 1 || age > REF_MAX_AGE_DAYS {
        return 0; // same-day or stale reference — no basis to halt
    }
    let drop = (halt.ref_price as i128 - price as i128) * 10_000;
    let ref_ = halt.ref_price as i128;
    if drop >= ref_ * L3_BPS {
        return 2;
    }
    if drop >= ref_ * L2_BPS {
        return if sod < L2_CUTOFF_MIN * 60 { 1 } else { 2 };
    }
    if drop >= ref_ * L1_BPS && sod < L2_CUTOFF_MIN * 60 {
        // L1 halts only before the cutoff; at/after 15:25 the day is minutes
        // from the calendar close — stand and let the bell handle it.
        return 1;
    }
    0
}

/// The two-crank confirmation gate. A breach on BOTH pools (the lesser
/// severity of the two rules) latches `pending_*`; only a still-breaching
/// crank after `CONFIRM_WINDOW_SECS` — and within `PENDING_MAX_SPAN_SECS`
/// of the first sighting — escalates. Returns the confirmed level (0, 1, 2)
/// and leaves `halt.pending_*` armed for the next crank otherwise.
fn confirm_breach(
    halt: &mut HaltState,
    prices: (i64, i64),
    cal: &CalendarData,
    now: i64,
) -> u8 {
    let level = breach_level(halt, prices.0, cal, now)
        .min(breach_level(halt, prices.1, cal, now));
    if level == 0 {
        halt.pending_since = 0;
        halt.pending_level = 0;
        return 0;
    }
    // Track the deepest level seen since arming: a deeper sighting can
    // escalate mid-window, never de-escalate (the exchange declares at the
    // moment the level is hit, even if prices bounce back).
    halt.pending_level = halt.pending_level.max(level);
    if halt.pending_since == 0 {
        halt.pending_since = now; // first sighting — arm, act on the next crank
        return 0;
    }
    let span = now - halt.pending_since;
    if !(CONFIRM_WINDOW_SECS..=PENDING_MAX_SPAN_SECS).contains(&span) {
        halt.pending_since = now; // stale sighting (e.g. across sessions) — re-arm
        return 0;
    }
    halt.pending_since = 0;
    let confirmed = halt.pending_level;
    halt.pending_level = 0;
    confirmed
}

/// Overlay the breaker decision onto the calendar-derived state and update
/// `HaltState` accordingly. Called from the crank with the validated pool
/// pair (if any). Also handles the reference capture at the close bell.
///
/// `cal_state` is the calendar's derived state (0/1/2); returns the
/// effective state (0/1/2/3).
pub fn apply_breaker(
    cal_state: u8,
    stored_state: u8,
    halt: &mut HaltState,
    pools: Option<(i64, i64)>,
    cal: &CalendarData,
    now: i64,
) -> u8 {
    let (today, _) = local_day_sod(cal, now);

    // A Level-3 day stays closed: the reference that tripped L3 keeps the
    // desk dark for the REST OF THE DAY — including the after-hours session
    // that evening (Rule 7.12: "remainder of the day") — even if after-hours
    // prices recover (which they can; the exchange already decided).
    if (cal_state == 0 || cal_state == 1) && halt.l3_day != 0 && halt.l3_day as i64 == today {
        return 2;
    }

    // The regular session: breaker checks + the active overlay.
    if cal_state == 0 {
        let level = pools.map(|p| confirm_breach(halt, p, cal, now)).unwrap_or(0);
        if level >= 2 {
            halt.halt_until = 0;
            halt.l3_day = today as u32;
            return 2;
        }
        if level == 1 {
            halt.halt_until = now + HALT_DURATION_SECS; // declare or re-arm
            return 3;
        }
        if halt.pending_since != 0 {
            // Breach sighted, confirmation pending: hold the current shape
            // (a still-halted desk stays halted; an open one stays open) so
            // confirmation can't churn transitions or bounties.
            return if stored_state == 3 { 3 } else { cal_state };
        }
        if halt.halt_until > now {
            return 3; // halted; expiry is checked below on later cranks
        }
        return cal_state;
    }

    // Reference capture: the observed close-bell transition (stored regular
    // session → calendar extended) takes pool A's price as tomorrow's
    // prior-close reference. An after-hours price minutes later sits within
    // bps of the close — far inside the −7% threshold — so late cranks are
    // harmless here.
    if cal_state == 1 && stored_state == 0 {
        if let Some((a, _)) = pools {
            if a > 0 {
                halt.ref_price = a;
                halt.ref_day = today as u32;
            }
        }
        // A halt/pending can't survive the session boundary anyway.
        halt.halt_until = 0;
        halt.pending_since = 0;
        halt.pending_level = 0;
        return cal_state;
    }

    // Outside the regular session the overlay is inert; expiry clears it.
    if halt.halt_until != 0 && halt.halt_until <= now {
        halt.halt_until = 0;
    }
    halt.pending_since = 0;
    halt.pending_level = 0;
    cal_state
}
