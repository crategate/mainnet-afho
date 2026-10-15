// ─────────────────────────────────────────────────────────────────────
// set-timezone — queue a tz/DST update for the market calendar.
//
// Session TIMES are frozen at launch. The one mutable timezone knob the
// calendar authority (Squads multisig) holds is the ET offset + DST rule,
// for a permanent US DST policy change (DST made year-round, or abolished).
// The annual spring-forward / fall-back recurrence is computed per year by
// the evaluator and needs no update. Queued as pending; activates at the
// next bell.
//
//   anchor run set-timezone                              # the standard ET rule
//   anchor run set-timezone -- --no-dst                 # DST abolished (EST year-round)
//   anchor run set-timezone -- --perm-dst               # DST year-round (EDT year-round)
//   anchor run set-timezone -- --dst-start=3,2,6 --dst-end=11,1,6   # moved months
//
// Run as the calendar authority (the multisig vault PDA, via Squads).
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { NYSE } from "../lib/calendar";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);
    const [marketCalendarPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_calendar")],
        program.programId
    );

    const args = new Set(process.argv.slice(2));
    let spec: { utcOffsetWinter: number; dstDeltaSec: number; dstStart: any; dstEnd: any };
    let label: string;
    if (args.has("--no-dst")) {
        // Permanent standard time: ET = UTC-5 all year.
        spec = { utcOffsetWinter: -18000, dstDeltaSec: 0, dstStart: NYSE.dstStart, dstEnd: NYSE.dstEnd };
        label = "permanent standard time (UTC-5 year-round)";
    } else if (args.has("--perm-dst")) {
        // Permanent daylight time: ET = UTC-4 all year.
        spec = { utcOffsetWinter: -14400, dstDeltaSec: 0, dstStart: NYSE.dstStart, dstEnd: NYSE.dstEnd };
        label = "permanent daylight time (UTC-4 year-round)";
    } else {
        // The standard ET rule launch uses.
        spec = { utcOffsetWinter: NYSE.utcOffsetWinter, dstDeltaSec: NYSE.dstDeltaSec, dstStart: NYSE.dstStart, dstEnd: NYSE.dstEnd };
        label = "standard ET (EST/EDT)";
    }

    // Custom DST boundaries — for a law change that moves the transition
    // MONTHS (the annual recurrence itself is computed per year by the
    // evaluator and never needs an update; only the rule does):
    //   --dst-start=month,week,weekday   e.g. --dst-start=3,2,6 (2nd Sun of March)
    //   --dst-end=month,week,weekday     e.g. --dst-end=11,1,6  (1st Sun of November)
    const boundary = (flag: string): { month: number; week: number; weekday: number } | null => {
        for (const a of process.argv.slice(2)) {
            if (a.startsWith(`--${flag}=`)) {
                const p = a.split("=")[1].split(",").map(Number);
                if (p.length !== 3 || p.some((n) => !Number.isInteger(n))) {
                    throw new Error(`--${flag} must be month,week,weekday (got ${a})`);
                }
                return { month: p[0], week: p[1], weekday: p[2] };
            }
        }
        return null;
    };
    const ds = boundary("dst-start");
    const de = boundary("dst-end");
    if (ds || de) {
        spec.dstStart = ds ?? spec.dstStart;
        spec.dstEnd = de ?? spec.dstEnd;
        label += ` — dst boundaries ${spec.dstStart.month}/${spec.dstStart.week}w → ${spec.dstEnd.month}/${spec.dstEnd.week}w`;
    }

    const sig = await program.methods
        .setTimezone(spec)
        .accounts({ calendarAuthority: provider.wallet.publicKey, marketCalendar: marketCalendarPda })
        .rpc();
    console.log(`timezone queued: ${label} (activates at the next bell) — ${sig}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
