import * as anchor from "@coral-xyz/anchor";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";

// =============================================================================
// diag-offer-gate.ts — READ-ONLY offer-desk day-flow guard probe
// =============================================================================
// Prints the four accounts whose day indices gate the desk day-flow, plus a
// verdict for what make_offers / calc_completed_offers would do RIGHT NOW:
//
//   market_status.trading_day_index   the "current_day" every guard compares
//   offer_list.day_index              stamped by make_offers (one sheet/day)
//   accepted_offers.day_index         stamped by calc_completed_offers
//   metrics.day_index                 stamped by update_tradeday_stats
//
// Guards (programs/amm/src/instructions):
//   make_offers           state ∈ {1,2} AND offer_list.day != current_day
//                         (else AlreadyConstructed)
//   calc_completed_offers state == 0 AND accepted.day != current_day
//                         AND offer_list.day == current_day − 1
//                         (else AlreadyConstructed / StaleOfferSheet)
//
// The day index rolls ONLY on (1|2)→0 — a 3→0 halt-lift does NOT roll it, so
// halt-flap cycles produce second closes at the same day index, which fail
// make_offers as "already built today" (normal, same class as the alt sheet's
// documented flapping noise).
//
// Usage: anchor run diag-offers   (or: npx ts-node scripts/ops/diag-offer-gate.ts)
// Sends NOTHING — reads only.

dotenv.config();

const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    return Number(v.toString());
};

function field<T>(obj: unknown, ...names: string[]): T | undefined {
    const record = obj as Record<string, unknown> | null | undefined;
    for (const n of names) {
        const v = record?.[n];
        if (v !== undefined && v !== null) return v as T;
    }
    return undefined;
}

function describeOffer(o: unknown): string {
    if (!o) return "—";
    const lot = num(field(o, "lot_size", "lotSize"));
    const rem = num(field(o, "remaining"));
    const tot = num(field(o, "total_offered", "totalOffered"));
    const disc = num(field(o, "discount_bps", "discountBps"));
    const vest = num(field(o, "vesting_days", "vestingDays"));
    if (!tot) return "empty";
    return `${rem}/${tot} lots × ${lot} · disc ${disc}0bps · vest ${vest}d`;
}

async function main() {
    const rpcUrl = process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL!;
    const connection = new Connection(rpcUrl, "confirmed");

    const idl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf8"),
    );
    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf8"),
    );
    const ammProgram = new PublicKey(deployment.ammProgram);
    const crankProgram = new PublicKey(deployment.crankProgram);
    const mint = new PublicKey(deployment.mint);
    const coder = new anchor.BorshAccountsCoder(idl);

    const marketStatusPda = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")], crankProgram)[0];
    const offerListPda = PublicKey.findProgramAddressSync(
        [Buffer.from("offer_list"), mint.toBuffer()], ammProgram)[0];
    const acceptedPda = PublicKey.findProgramAddressSync(
        [Buffer.from("accepted_offers"), mint.toBuffer()], ammProgram)[0];
    const metricsPda = PublicKey.findProgramAddressSync(
        [Buffer.from("metrics"), mint.toBuffer()], ammProgram)[0];

    const [msInfo, olInfo, aoInfo, mmInfo] = await connection.getMultipleAccountsInfo(
        [marketStatusPda, offerListPda, acceptedPda, metricsPda], "confirmed");

    if (!msInfo) throw new Error("market_status not found — wrong cluster/deployment?");
    const view = new DataView(msInfo.data.buffer, msInfo.data.byteOffset, msInfo.data.byteLength);
    const state = view.getUint8(8);
    const day = Number(view.getBigUint64(17, true));

    const offerList = olInfo ? coder.decode("OfferList", Buffer.from(olInfo.data)) : null;
    const accepted = aoInfo ? coder.decode("AcceptedOffers", Buffer.from(aoInfo.data)) : null;
    const metrics = mmInfo ? coder.decode("MarketMetrics", Buffer.from(mmInfo.data)) : null;

    const olDay = num(field(offerList, "day_index", "dayIndex"));
    const aoDay = num(field(accepted, "day_index", "dayIndex"));
    const mmDay = num(field(metrics, "day_index", "dayIndex"));
    const momentum = num(field(metrics, "momentum_score", "momentumScore"));

    console.log(`cluster:            ${rpcUrl}`);
    console.log(`market_status:      state ${state}  trading_day ${day}`);
    console.log(`offer_list:         day_index ${olDay}  (sheet: sml ${describeOffer(field(offerList, "sml_offer", "smlOffer"))} | med ${describeOffer(field(offerList, "med_offer", "medOffer"))} | big ${describeOffer(field(offerList, "big_offer", "bigOffer"))})`);
    console.log(`accepted_offers:    day_index ${aoDay}`);
    console.log(`metrics:            day_index ${mmDay}  momentum ${momentum}`);
    console.log("");

    const night = state === 1 || state === 2;
    const makeOk = night && olDay !== day;
    console.log(`make_offers NOW:        ${makeOk ? "would PASS" : "would FAIL"}`);
    if (!night) console.log(`  ✗ state ${state} ∉ {1,2} → InvalidMarketState (need a night state)`);
    if (olDay === day) console.log(`  ✗ offer_list.day ${olDay} == current ${day} → AlreadyConstructed (sheet already built for THIS day index)`);

    const calcStateOk = state === 0;
    const calcAccOk = aoDay !== day;
    const calcSheetOk = olDay === day - 1;
    console.log(`calc_completed NOW:     ${calcStateOk && calcAccOk && calcSheetOk ? "would PASS" : "would FAIL"}`);
    if (!calcStateOk) console.log(`  ✗ state ${state} ≠ 0 → InvalidMarketState (need the open)`);
    if (!calcAccOk) console.log(`  ✗ accepted_offers.day ${aoDay} == current ${day} → AlreadyConstructed (already scored this day)`);
    if (!calcSheetOk) console.log(`  ✗ offer_list.day ${olDay} ≠ current−1 (${day - 1}) → StaleOfferSheet (last night's make_offers never landed — cascade)`);
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
