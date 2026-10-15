//! The market calendar: schedule-as-data types, exact integer civil-date
//! arithmetic, and the pure session evaluator.
//!
//! The program contains no NYSE constants — session rules, holiday/half-day
//! overrides, and the ET timezone/DST definition are DATA in the
//! `market_calendar` PDA. Session TIMES are frozen; the calendar authority owns
//! only the mutable data (`set_holidays`, `set_timezone`). The evaluator is a
//! pure function of `(CalendarData, unix_timestamp)`: nobody signs opinions,
//! and market status is always derived, never declared.

/// Weekdays: 0 = Monday … 6 = Sunday (days_mask bit `1 << weekday`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SessionRule {
    pub days_mask: u8,
    /// Local minutes-of-day, inclusive.
    pub start_min: u16,
    /// Exclusive; 1440 allowed (pair with a 0-start rule for sessions
    /// crossing midnight).
    pub end_min: u16,
    /// 0 = regular session (open), 1 = extended. 2/3 are rejected by validation —
    /// closed is the evaluator's fallback and state 3 (halted) belongs to
    /// the circuit-breaker layer alone.
    pub state: u8,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CalendarDateRule {
    pub month: u8,   // 1..=12
    pub week: u8,    // 1..=5 (nth occurrence of the weekday; clamps to last)
    pub weekday: u8, // 0 = Monday … 6 = Sunday
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CalendarOverride {
    /// Days since 1970-01-01 (local date), strictly ascending.
    pub date: u32,
    /// 0 = full close, 1 = half day (sessions clamped at half_day_close_min).
    pub kind: u8,
}

pub const MAX_RULES: usize = 8;
pub const MAX_OVERRIDES: usize = 40;
/// CalendarData wire size (borsh, fixed): version(4)+updated_at(8)
/// +utc_offset_winter(4)+dst_delta_sec(4)+dst_start(3)+dst_end(3)
/// +half_day_close_min(2)+rules(8×6)+rule_count(1)+overrides(40×5)
/// +override_count(1) = 278.
pub const CALENDAR_DATA_SPACE: usize = 278;
/// tz/DST part arg wire size: utc_offset(4)+dst_delta(4)+dst_start(3)
/// +dst_end(3) = 14. The ONE timezone knob the calendar authority holds —
/// session times are frozen, so ``set_timezone`` carries no rules.
pub const TIMEZONE_PART_SPACE: usize = 14;
/// Overrides-part arg wire size: overrides(200)+override_count(1) = 201.
pub const OVERRIDES_PART_SPACE: usize = 201;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CalendarData {
    pub version: u32,
    pub updated_at: i64,
    /// Seconds east of UTC in standard time (ET: -18000).
    pub utc_offset_winter: i32,
    /// Added during the DST window (0 = no DST).
    pub dst_delta_sec: i32,
    pub dst_start: CalendarDateRule,
    pub dst_end: CalendarDateRule,
    /// Regular-session end on half days (ET: 780 = 13:00).
    pub half_day_close_min: u16,
    pub rules: [SessionRule; MAX_RULES],
    pub rule_count: u8,
    pub overrides: [CalendarOverride; MAX_OVERRIDES],
    pub override_count: u8,
}

impl Default for CalendarData {
    fn default() -> Self {
        CalendarData {
            version: 0,
            updated_at: 0,
            utc_offset_winter: 0,
            dst_delta_sec: 0,
            dst_start: CalendarDateRule { month: 0, week: 0, weekday: 0 },
            dst_end: CalendarDateRule { month: 0, week: 0, weekday: 0 },
            half_day_close_min: 0,
            rules: [SessionRule { days_mask: 0, start_min: 0, end_min: 0, state: 0 }; MAX_RULES],
            rule_count: 0,
            overrides: [CalendarOverride { date: 0, kind: 0 }; MAX_OVERRIDES],
            override_count: 0,
        }
    }
}

// ─────────────────────────── wire codecs ───────────────────────────────────

pub fn calendar_data_from_bytes(b: &[u8]) -> Result<CalendarData, solana_program::program_error::ProgramError> {
    use solana_program::program_error::ProgramError;
    if b.len() < CALENDAR_DATA_SPACE {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut cd = CalendarData {
        version: u32::from_le_bytes(b[0..4].try_into().unwrap()),
        updated_at: i64::from_le_bytes(b[4..12].try_into().unwrap()),
        utc_offset_winter: i32::from_le_bytes(b[12..16].try_into().unwrap()),
        dst_delta_sec: i32::from_le_bytes(b[16..20].try_into().unwrap()),
        dst_start: CalendarDateRule { month: b[20], week: b[21], weekday: b[22] },
        dst_end: CalendarDateRule { month: b[23], week: b[24], weekday: b[25] },
        half_day_close_min: u16::from_le_bytes(b[26..28].try_into().unwrap()),
        ..CalendarData::default()
    };
    for i in 0..MAX_RULES {
        let o = 28 + i * 6;
        cd.rules[i] = SessionRule {
            days_mask: b[o],
            start_min: u16::from_le_bytes(b[o + 1..o + 3].try_into().unwrap()),
            end_min: u16::from_le_bytes(b[o + 3..o + 5].try_into().unwrap()),
            state: b[o + 5],
        };
    }
    cd.rule_count = b[76];
    for i in 0..MAX_OVERRIDES {
        let o = 77 + i * 5;
        cd.overrides[i] = CalendarOverride {
            date: u32::from_le_bytes(b[o..o + 4].try_into().unwrap()),
            kind: b[o + 4],
        };
    }
    cd.override_count = b[277];
    Ok(cd)
}

pub fn calendar_data_to_bytes(cd: &CalendarData) -> [u8; CALENDAR_DATA_SPACE] {
    let mut b = [0u8; CALENDAR_DATA_SPACE];
    b[0..4].copy_from_slice(&cd.version.to_le_bytes());
    b[4..12].copy_from_slice(&cd.updated_at.to_le_bytes());
    b[12..16].copy_from_slice(&cd.utc_offset_winter.to_le_bytes());
    b[16..20].copy_from_slice(&cd.dst_delta_sec.to_le_bytes());
    b[20] = cd.dst_start.month;
    b[21] = cd.dst_start.week;
    b[22] = cd.dst_start.weekday;
    b[23] = cd.dst_end.month;
    b[24] = cd.dst_end.week;
    b[25] = cd.dst_end.weekday;
    b[26..28].copy_from_slice(&cd.half_day_close_min.to_le_bytes());
    for i in 0..MAX_RULES {
        let o = 28 + i * 6;
        let r = &cd.rules[i];
        b[o] = r.days_mask;
        b[o + 1..o + 3].copy_from_slice(&r.start_min.to_le_bytes());
        b[o + 3..o + 5].copy_from_slice(&r.end_min.to_le_bytes());
        b[o + 5] = r.state;
    }
    b[76] = cd.rule_count;
    for i in 0..MAX_OVERRIDES {
        let o = 77 + i * 5;
        let v = &cd.overrides[i];
        b[o..o + 4].copy_from_slice(&v.date.to_le_bytes());
        b[o + 4] = v.kind;
    }
    b[277] = cd.override_count;
    b
}

/// Apply a tz/DST (timezone) part onto a CalendarData. Everything else
/// (session rules, half-day close) is left untouched.
pub fn apply_timezone_part(
    cd: &mut CalendarData,
    b: &[u8],
) -> Result<(), solana_program::program_error::ProgramError> {
    use solana_program::program_error::ProgramError;
    if b.len() < TIMEZONE_PART_SPACE {
        return Err(ProgramError::InvalidInstructionData);
    }
    cd.utc_offset_winter = i32::from_le_bytes(b[0..4].try_into().unwrap());
    cd.dst_delta_sec = i32::from_le_bytes(b[4..8].try_into().unwrap());
    cd.dst_start = CalendarDateRule { month: b[8], week: b[9], weekday: b[10] };
    cd.dst_end = CalendarDateRule { month: b[11], week: b[12], weekday: b[13] };
    Ok(())
}

/// Apply a holidays (overrides) part onto a CalendarData.
pub fn apply_holidays_part(
    cd: &mut CalendarData,
    b: &[u8],
) -> Result<(), solana_program::program_error::ProgramError> {
    use solana_program::program_error::ProgramError;
    if b.len() < OVERRIDES_PART_SPACE {
        return Err(ProgramError::InvalidInstructionData);
    }
    for i in 0..MAX_OVERRIDES {
        let o = i * 5;
        cd.overrides[i] = CalendarOverride {
            date: u32::from_le_bytes(b[o..o + 4].try_into().unwrap()),
            kind: b[o + 4],
        };
    }
    cd.override_count = b[200];
    Ok(())
}

// ─────────────────── exact integer civil-date arithmetic ───────────────────
// Howard Hinnant's algorithms — no floating point on-chain.

/// days since 1970-01-01 → (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468; // shift to the 0000-03-01 civil epoch
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month as u32, day as u32)
}

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday = 3).
pub fn weekday_from_days(days: i64) -> u8 {
    ((days + 3).rem_euclid(7)) as u8
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Day-of-month of the `n`th `weekday` in `month` (clamped to the last
/// occurrence when the nth doesn't exist).
pub fn nth_weekday_day(y: i64, m: u32, weekday: u8, n: u8) -> u32 {
    let first = weekday_from_days(days_from_civil(y, m, 1));
    let mut dom = 1 + ((weekday as i64 + 7 - first as i64) % 7) + (n as i64 - 1) * 7;
    let dim = days_in_month(y, m) as i64;
    while dom > dim {
        dom -= 7;
    }
    dom as u32
}

// ─────────────────────────── the evaluator ─────────────────────────────────

/// DST window membership for a local day (day-granular; the 2 a.m. flip
/// lands while the market is closed).
fn dst_active(cal: &CalendarData, naive_days: i64) -> bool {
    if cal.dst_delta_sec == 0 {
        return false;
    }
    let (y, _, _) = civil_from_days(naive_days);
    let s = days_from_civil(
        y,
        cal.dst_start.month as u32,
        nth_weekday_day(y, cal.dst_start.month as u32, cal.dst_start.weekday, cal.dst_start.week),
    );
    let e = days_from_civil(
        y,
        cal.dst_end.month as u32,
        nth_weekday_day(y, cal.dst_end.month as u32, cal.dst_end.weekday, cal.dst_end.week),
    );
    naive_days >= s && naive_days < e
}

/// unix ts → (local day since epoch, local seconds-of-day).
pub fn local_day_sod(cal: &CalendarData, ts: i64) -> (i64, i64) {
    let naive = ts + cal.utc_offset_winter as i64;
    let day = naive.div_euclid(86_400);
    let adj = if dst_active(cal, day) { cal.dst_delta_sec as i64 } else { 0 };
    let local = naive + adj;
    (local.div_euclid(86_400), local.rem_euclid(86_400))
}

/// unix ts of local `minute` on local day `day`.
pub fn abs_local_minute(cal: &CalendarData, day: i64, minute: u16) -> i64 {
    let offset = cal.utc_offset_winter as i64
        + if dst_active(cal, day) { cal.dst_delta_sec as i64 } else { 0 };
    day * 86_400 + minute as i64 * 60 - offset
}

fn override_for(cal: &CalendarData, day: i64) -> Option<u8> {
    cal.overrides[..cal.override_count as usize]
        .iter()
        .find(|o| o.date as i64 == day)
        .map(|o| o.kind)
}

/// Session bounds after override adjustment, or None when the rule doesn't
/// apply (wrong weekday / empty after clamping).
fn rule_bounds(cal: &CalendarData, rule: &SessionRule, day: i64, half_day: bool) -> Option<(u16, u16)> {
    if rule.days_mask & (1 << weekday_from_days(day)) == 0 {
        return None;
    }
    let (mut s, mut e) = (rule.start_min, rule.end_min);
    if half_day {
        let hc = cal.half_day_close_min;
        if rule.state == 0 {
            e = e.min(hc);
        } else if rule.state == 1 && s >= hc {
            // Afternoon extended session on a half day: starts at the close
            // and runs at most 4h (NYSE after-hours on half days: 13:00–17:00).
            s = hc;
            e = e.min(hc.saturating_add(240));
        }
    }
    if s >= e {
        return None;
    }
    Some((s, e))
}

/// The derived market state at `ts`: 0 = regular (open), 1 = extended,
/// 2 = closed (default). State 3 (halted) can NEVER come from the calendar — it
/// belongs to the circuit-breaker layer.
pub fn eval_state(cal: &CalendarData, ts: i64) -> u8 {
    let (day, sod) = local_day_sod(cal, ts);
    match override_for(cal, day) {
        Some(0) => return 2, // override kind 0 = full close -> state 2 (closed)
        _ => {}
    }
    let half_day = override_for(cal, day) == Some(1);
    for rule in &cal.rules[..cal.rule_count as usize] {
        if let Some((s, e)) = rule_bounds(cal, rule, day, half_day) {
            if sod >= s as i64 * 60 && sod < e as i64 * 60 {
                return rule.state;
            }
        }
    }
    2 // no session window (nights/weekends) = closed
}

/// The most recent session bell (rule start or end, override-adjusted) at or
/// before `now` — the exact moment the CURRENT state began. Scans back four
/// days so a Sunday-evening or holiday-Monday close attributes to Friday's
/// last bell.
pub fn last_boundary(cal: &CalendarData, now: i64) -> i64 {
    let (day, _) = local_day_sod(cal, now);
    let mut best: i64 = 0;
    for d in [day, day - 1, day - 2, day - 3] {
        if override_for(cal, d) == Some(0) {
            continue;
        }
        let half_day = override_for(cal, d) == Some(1);
        for rule in &cal.rules[..cal.rule_count as usize] {
            if let Some((s, e)) = rule_bounds(cal, rule, d, half_day) {
                for m in [s, e] {
                    let ts = abs_local_minute(cal, d, m);
                    if ts <= now && ts > best {
                        best = ts;
                    }
                }
            }
        }
    }
    if best == 0 {
        now
    } else {
        best
    }
}

/// Validation for the calendar parts. Invariants the evaluator relies on:
/// sorted non-overlapping rules with states {0,1}; ascending unique override
/// dates with kinds {0,1}; a sane non-wrapping DST window; count bounds.
pub fn validate_calendar_data(cd: &CalendarData) -> Result<(), solana_program::program_error::ProgramError> {
    use solana_program::program_error::ProgramError;
    use crate::constants::*;
    if cd.rule_count as usize > MAX_RULES || cd.override_count as usize > MAX_OVERRIDES {
        return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_DATA));
    }
    for r in &cd.rules[..cd.rule_count as usize] {
        if r.state == 2 || r.state > 1 {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_RULE));
        }
        if r.start_min >= r.end_min || r.end_min > 1440 || r.days_mask == 0 {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_RULE));
        }
    }
    for i in 1..cd.rule_count as usize {
        if cd.rules[i - 1].end_min > cd.rules[i].start_min {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_RULE)); // overlap / unsorted
        }
    }
    for o in &cd.overrides[..cd.override_count as usize] {
        if o.kind > 1 {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_DATA));
        }
    }
    for i in 1..cd.override_count as usize {
        if cd.overrides[i - 1].date >= cd.overrides[i].date {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_DATA)); // unsorted / duplicate
        }
    }
    for d in [&cd.dst_start, &cd.dst_end] {
        if d.month < 1 || d.month > 12 || d.week < 1 || d.week > 5 || d.weekday > 6 {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_DATA));
        }
    }
    if cd.dst_delta_sec != 0 {
        let y = cd.updated_at.div_euclid(31_557_600) + 1970; // rough year — only for window ordering
        let s = days_from_civil(
            y,
            cd.dst_start.month as u32,
            nth_weekday_day(y, cd.dst_start.month as u32, cd.dst_start.weekday, cd.dst_start.week),
        );
        let e = days_from_civil(
            y,
            cd.dst_end.month as u32,
            nth_weekday_day(y, cd.dst_end.month as u32, cd.dst_end.weekday, cd.dst_end.week),
        );
        if s >= e {
            return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_DATA)); // wrap-around unsupported
        }
    }
    if cd.half_day_close_min == 0 || cd.half_day_close_min > 1440 {
        return Err(ProgramError::Custom(ERR_INVALID_CALENDAR_DATA));
    }
    Ok(())
}
