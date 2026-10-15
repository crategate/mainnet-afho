// ─────────────────────────────────────────────────────────────────────
// calendar.ts — TypeScript mirror of the on-chain calendar evaluator
// (programs/crank-oracle/src/lib.rs). The keeper uses it to decide WHEN to
// crank (expected state vs stored state); the PROGRAM is the source of
// truth — any drift here costs the keeper a failed transaction, never a
// wrong state on-chain.
//
// The calendar is DATA (no NYSE constants live in any program): session
// rules + holiday/half-day overrides + the ET timezone/DST definition are
// stored in the `market_calendar` PDA and updated by its authority via
// set_calendar (pending → activates at the next bell).
// ─────────────────────────────────────────────────────────────────────

export interface SessionRule {
    daysMask: number; // bit i = weekday i (0 = Monday … 6 = Sunday)
    startMin: number; // local minutes-of-day, inclusive
    endMin: number; // exclusive (1440 allowed)
    state: number; // 0 = regular (open), 1 = extended
}
export interface CalendarDateRule {
    month: number; // 1..=12
    week: number; // 1..=5 (nth weekday; clamps to last)
    weekday: number; // 0 = Monday … 6 = Sunday
}
export interface CalendarOverride {
    date: number; // days since 1970-01-01 (local date)
    kind: number; // 0 = full close, 1 = half day
}
export interface CalendarData {
    version: number;
    updatedAt: number;
    utcOffsetWinter: number; // seconds east of UTC in standard time (ET: -18000)
    dstDeltaSec: number; // added during the DST window (0 = no DST)
    dstStart: CalendarDateRule;
    dstEnd: CalendarDateRule;
    halfDayCloseMin: number; // regular-session end on half days (ET: 780)
    rules: SessionRule[];
    overrides: CalendarOverride[];
}

// ── exact integer civil-date arithmetic (Hinnant) ─────────────────────

export function civilFromDays(days: number): { y: number; m: number; d: number } {
    const z = Math.trunc(days) + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097; // [0, 146096]
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return { y: m <= 2 ? y + 1 : y, m, d };
}

export function daysFromCivil(y: number, m: number, d: number): number {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const mp = m > 2 ? m - 3 : m + 9;
    const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

/** 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday = 3). */
export function weekdayFromDays(days: number): number {
    return (((days + 3) % 7) + 7) % 7;
}

function daysInMonth(y: number, m: number): number {
    switch (m) {
        case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
        case 4: case 6: case 9: case 11: return 30;
        case 2: return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
        default: return 0;
    }
}

function nthWeekdayDay(y: number, m: number, weekday: number, n: number): number {
    const first = weekdayFromDays(daysFromCivil(y, m, 1));
    let dom = 1 + ((weekday + 7 - first) % 7) + (n - 1) * 7;
    const dim = daysInMonth(y, m);
    while (dom > dim) dom -= 7;
    return dom;
}

// ── evaluator (mirror of the Rust) ────────────────────────────────────

function dstActive(cal: CalendarData, naiveDays: number): boolean {
    if (cal.dstDeltaSec === 0) return false;
    const { y } = civilFromDays(naiveDays);
    const s = daysFromCivil(y, cal.dstStart.month, nthWeekdayDay(y, cal.dstStart.month, cal.dstStart.weekday, cal.dstStart.week));
    const e = daysFromCivil(y, cal.dstEnd.month, nthWeekdayDay(y, cal.dstEnd.month, cal.dstEnd.weekday, cal.dstEnd.week));
    return naiveDays >= s && naiveDays < e;
}

/** Local calendar day + seconds-of-day for a unix ts (mirror of the Rust). */
export function localDaySod(cal: CalendarData, ts: number): { day: number; sod: number } {
    const naive = ts + cal.utcOffsetWinter;
    const day = Math.floor(naive / 86400);
    const adj = dstActive(cal, day) ? cal.dstDeltaSec : 0;
    const local = naive + adj;
    return { day: Math.floor(local / 86400), sod: ((local % 86400) + 86400) % 86400 };
}

function absLocalMinute(cal: CalendarData, day: number, minute: number): number {
    const offset = cal.utcOffsetWinter + (dstActive(cal, day) ? cal.dstDeltaSec : 0);
    return day * 86400 + minute * 60 - offset;
}

function ruleBounds(cal: CalendarData, r: SessionRule, day: number, halfDay: boolean): [number, number] | null {
    if ((r.daysMask & (1 << weekdayFromDays(day))) === 0) return null;
    let { startMin: s, endMin: e } = r;
    if (halfDay) {
        const hc = cal.halfDayCloseMin;
        if (r.state === 0) {
            e = Math.min(e, hc);
        } else if (r.state === 1 && s >= hc) {
            s = hc;
            e = Math.min(e, hc + 240);
        }
    }
    if (s >= e) return null;
    return [s, e];
}

/** The derived market state at unix time `tsSec`: 0 regular (open) / 1 extended / 2 closed. */
export function evalState(cal: CalendarData, tsSec: number): number {
    const { day, sod } = localDaySod(cal, tsSec);
    for (const o of cal.overrides) {
        if (o.date === day) {
            if (o.kind === 0) return 2; // override kind 0 = full close → state 2
            break; // half day — fall through with clamped sessions
        }
    }
    const halfDay = cal.overrides.some((o) => o.date === day && o.kind === 1);
    for (const r of cal.rules) {
        const b = ruleBounds(cal, r, day, halfDay);
        if (b && sod >= b[0] * 60 && sod < b[1] * 60) return r.state;
    }
    return 2; // no session window (nights/weekends) = closed
}

/** The most recent session bell at or before `tsSec` (scan back 4 days). */
export function lastBoundary(cal: CalendarData, tsSec: number): number {
    const { day } = localDaySod(cal, tsSec);
    let best = 0;
    for (let d = day; d >= day - 3; d--) {
        if (cal.overrides.some((o) => o.date === d && o.kind === 0)) continue;
        const halfDay = cal.overrides.some((o) => o.date === d && o.kind === 1);
        for (const r of cal.rules) {
            const b = ruleBounds(cal, r, d, halfDay);
            if (!b) continue;
            for (const m of b) {
                const ts = absLocalMinute(cal, d, m);
                if (ts <= tsSec && ts > best) best = ts;
            }
        }
    }
    return best === 0 ? tsSec : best;
}

// ── anchor account → CalendarData ─────────────────────────────────────

/** Map one anchor-decoded CalendarData block (active or pending). */
export function fromAnchorData(d: any): CalendarData {
    return {
        version: d.version,
        updatedAt: d.updatedAt,
        utcOffsetWinter: d.utcOffsetWinter,
        dstDeltaSec: d.dstDeltaSec,
        dstStart: d.dstStart,
        dstEnd: d.dstEnd,
        halfDayCloseMin: d.halfDayCloseMin,
        rules: d.rules.slice(0, d.ruleCount),
        overrides: d.overrides.slice(0, d.overrideCount),
    };
}

/** Map the anchor-decoded marketCalendar account (active block). */
export function fromAnchorAccount(acc: any): CalendarData {
    return fromAnchorData(acc.active);
}

// ── default NYSE schedule (what init-calendar.ts writes) ──────────────

export const NYSE = {
    utcOffsetWinter: -18000,
    dstDeltaSec: 3600,
    dstStart: { month: 3, week: 2, weekday: 6 }, // 2nd Sunday of March
    dstEnd: { month: 11, week: 1, weekday: 6 }, // 1st Sunday of November
    halfDayCloseMin: 780, // 13:00 ET
    weekdayMask: 0b0001_1111, // Mon..Fri
    rules: [
        { startMin: 240, endMin: 570, state: 1 }, // 04:00–09:30 pre
        { startMin: 570, endMin: 960, state: 0 }, // 09:30–16:00 regular
        { startMin: 960, endMin: 1200, state: 1 }, // 16:00–20:00 post
    ] as { startMin: number; endMin: number; state: number }[],
};
