// ─────────────────────────────────────────────────────────────────────
// init-calendar — write the NYSE schedule into the market_calendar PDA.
//
// The calendar is DATA: session rules + holiday/half-day overrides + the
// ET timezone/DST definition, sourced from nyse-holidays.json (maintained
// from NYSE's published calendar). Session TIMES are frozen at init — no
// setter; the calendar authority (Squads multisig) refreshes HOLIDAYS.
//
//   account missing  → initialize_calendar (payer becomes the calendar
//                      authority; the full schedule is written once)
//   account exists   → set_holidays (queues into the pending block that
//                      activates at the next session bell — the yearly
//                      holiday refresh)
//
// Run it when NYSE publishes the next year's holidays. A permanent DST
// policy change uses set-timezone.ts instead; trade hours never change.
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { NYSE, daysFromCivil } from "../lib/calendar";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;
    const payer = provider.wallet;

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);
    const programId = program.programId;

    const [marketCalendarPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_calendar")],
        programId
    );

    // holidays json → overrides (sorted by date — the program enforces this)
    const holidaysPath = path.join(process.cwd(), "scripts", "lib", "nyse-holidays.json");
    const holidays = JSON.parse(fs.readFileSync(holidaysPath, "utf-8"));
    const toDays = (iso: string): number => {
        const [y, m, d] = iso.split("-").map(Number);
        return daysFromCivil(y, m, d);
    };
    const overrides = [
        ...holidays.closures.map((iso: string) => ({ date: toDays(iso), kind: 0 })),
        ...holidays.halfDays.map((iso: string) => ({ date: toDays(iso), kind: 1 })),
    ].sort((a: any, b: any) => a.date - b.date);
    if (new Set(overrides.map((o: any) => o.date)).size !== overrides.length) {
        throw new Error("nyse-holidays.json: a date appears as both a closure and a half day");
    }
    if (overrides.length > 40) {
        throw new Error(`nyse-holidays.json: ${overrides.length} overrides exceed the 40-slot PDA capacity`);
    }

    // Fixed-size wire args (borsh): 8 rules / 40 overrides, zero-padded.
    const padRules = (rules: any[], n: number) =>
        Array.from({ length: n }, (_, i) => rules[i] ?? { daysMask: 0, startMin: 0, endMin: 0, state: 0 });
    const padOverrides = (ovs: any[], n: number) =>
        Array.from({ length: n }, (_, i) => ovs[i] ?? { date: 0, kind: 0 });

    const data = {
        version: 0, // program sets: 1 on init, active+1 on set
        updatedAt: new BN(0),
        utcOffsetWinter: NYSE.utcOffsetWinter,
        dstDeltaSec: NYSE.dstDeltaSec,
        dstStart: NYSE.dstStart,
        dstEnd: NYSE.dstEnd,
        halfDayCloseMin: NYSE.halfDayCloseMin,
        rules: padRules(
            NYSE.rules.map((r) => ({ daysMask: NYSE.weekdayMask, startMin: r.startMin, endMin: r.endMin, state: r.state })),
            8
        ),
        ruleCount: NYSE.rules.length,
        overrides: padOverrides(
            overrides.map((o: any) => ({ date: new BN(o.date), kind: o.kind })),
            40
        ),
        overrideCount: overrides.length,
    };

    const overridesSpec = {
        overrides: data.overrides,
        overrideCount: data.overrideCount,
    };

    const existing = await (program.account as any).marketCalendar.fetchNullable(marketCalendarPda);
    if (existing === null) {
        const sig = await program.methods
            .initializeCalendar(data)
            .accounts({
                marketCalendar: marketCalendarPda,
                payer: payer.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
        console.log(`market_calendar INITIALIZED @ ${marketCalendarPda.toBase58()} (authority: payer) — ${sig}`);
    } else {
        // The session rules are FROZEN at init — only the holiday/half-day
        // list is refreshed here (the calendar authority = Squads multisig).
        // Trade hours never change; a tz/DST policy change uses set-timezone.
        try {
            const sig = await program.methods
                .setHolidays(overridesSpec)
                .accounts({ calendarAuthority: payer.publicKey, marketCalendar: marketCalendarPda })
                .rpc();
            console.log(`holidays QUEUED (activates at the next bell) — ${sig}`);
        } catch (e: any) {
            if (String(e?.message ?? e).includes("0x1785")) {
                console.log("holidays already queued — skipped");
            } else {
                throw e;
            }
        }
    }

    console.log(`rules: ${data.ruleCount} sessions | overrides: ${data.overrideCount} dates (see nyse-holidays.json)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
