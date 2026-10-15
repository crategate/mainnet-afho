// ─────────────────────────────────────────────────────────────────────
// calendar-check — print the on-chain calendar's upcoming bells.
//
//   anchor run cal-check            # next 12 bells from the LIVE PDA
//   N=48 anchor run cal-check       # more
//
// Reads the market_calendar PDA (the schedule the PROGRAM evaluates — not
// the JSON file), derives the current state with the TS mirror, and lists
// upcoming session boundaries with the state they transition to. Use this
// to know when the next paid crank lands, to sanity-check an update before
// the bell, and to verify the site after a transition (the keeper or any
// MEV bot lands the crank within ~a minute of each bell).
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import {
    CalendarData,
    civilFromDays,
    evalState,
    fromAnchorAccount,
    fromAnchorData,
    daysFromCivil,
    weekdayFromDays,
} from "../lib/calendar";

const N = parseInt(process.env.N ?? "12", 10);

function etWall(ts: number): string {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(new Date(ts * 1000));
}

/// DST active for a local day (mirrors the evaluator's day-granular rule).
function dstActive(cal: CalendarData, day: number): boolean {
    if (cal.dstDeltaSec === 0) return false;
    const yy = civilFromDays(day).y;
    const nth = (dr: { month: number; week: number; weekday: number }) => {
        const first = weekdayFromDays(daysFromCivil(yy, dr.month, 1));
        let dom = 1 + ((dr.weekday + 7 - first) % 7) + (dr.week - 1) * 7;
        let dim = new Date(Date.UTC(yy, dr.month, 0)).getUTCDate();
        while (dom > dim) dom -= 7;
        return daysFromCivil(yy, dr.month, dom);
    };
    return day >= nth(cal.dstStart) && day < nth(cal.dstEnd);
}

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);
    const [marketCalendarPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_calendar")],
        program.programId
    );
    const [marketStatusPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        program.programId
    );

    const cal = await (program.account as any).marketCalendar.fetchNullable(marketCalendarPda);
    if (!cal) throw new Error("market_calendar not initialized — run 'anchor run init-calendar'");
    const data = fromAnchorAccount(cal);
    const pending = cal.hasPending ? fromAnchorData(cal.pending) : null;

    const status = await (program.account as any).marketStatus.fetchNullable(marketStatusPda);
    const now = Math.floor(Date.now() / 1000);

    console.log(`market_calendar @ ${marketCalendarPda.toBase58()}  (v${data.version}, ${data.rules.length} rules, ${data.overrides.length} overrides)`);
    console.log(`calendar authority (hours + holidays): ${cal.calendarAuthority}`);
    if (cal.hasPending) {
        console.log(
            `PENDING v${pending!.version} queued (${[cal.pendingTradeHours ? "trade hours" : null, cal.pendingHolidays ? "holidays" : null].filter(Boolean).join(" + ")}) — activates at the next bell`
        );
    }
    console.log(`\nnow: ${etWall(now)} ET  (unix ${now})`);
    const derivedNow = evalState(data, now);
    console.log(`derived state now: ${derivedNow}  (0 open / 1 extended / 2 closed)`);
    if (status) {
        const onChain = Number(status.currentState);
        const mismatch = onChain !== derivedNow;
        console.log(
            `on-chain MarketStatus: state ${onChain}, day ${status.tradingDayIndex}, bell ts ${status.lastUpdatedTimestamp} (${etWall(Number(status.lastUpdatedTimestamp))} ET)${mismatch ? "  ← TRANSITION DUE (crank it or wait for the keeper)" : ""}`
        );
    }

    // Enumerate bells: probe the minute before/at every rule edge for the
    // next 10 days; a bell is real only when the derived state changes.
    const bells: { ts: number; from: number; to: number }[] = [];
    const dayNow = Math.floor((now + data.utcOffsetWinter) / 86400);
    for (let d = dayNow; d <= dayNow + 10; d++) {
        const offset = data.utcOffsetWinter + (dstActive(data, d) ? data.dstDeltaSec : 0);
        for (const r of data.rules) {
            for (const m of [r.startMin, r.endMin]) {
                const ts = d * 86400 + m * 60 - offset;
                if (ts <= now) continue;
                const before = evalState(data, ts - 60);
                const at = evalState(data, ts);
                if (before !== at) bells.push({ ts, from: before, to: at });
            }
        }
    }
    bells.sort((a, b) => a.ts - b.ts);
    const seen = new Set<number>();
    const unique = bells.filter((b) => (seen.has(b.ts) ? false : (seen.add(b.ts), true)));

    console.log(`\nnext ${Math.min(N, unique.length)} bells:`);
    for (const b of unique.slice(0, N)) {
        const inDays = ((b.ts - now) / 86400).toFixed(1);
        const rolls = b.to === 0 && (b.from === 1 || b.from === 2) ? "   [trading day rolls]" : "";
        console.log(`  ${etWall(b.ts)} ET  (in ${inDays}d)  ${b.from} → ${b.to}${rolls}`);
    }
    if (unique.length === 0) console.log("  (none in the next 10 days — fully closed calendar?)");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
