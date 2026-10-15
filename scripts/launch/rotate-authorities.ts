import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Rotates protocol authorities onto a multisig (a Squads vault PDA).
//
//   AMM            AmmState.authority   → gates set_keeper + set_cpmm_pool + set_sol_usdc_pool
//   staking        StakePool.authority  → gates deposit_rewards
//   crank          BountyConfig.authority → gates set_bounty_usd + set_bounty_amount (+ set_authority)
//   calendar       MarketCalendar.calendar_authority → gates set_holidays + set_timezone (holidays + tz/DST)
//                  AND set_holidays (holiday closures/half-days) — ONE knob, see
//                  docs/AUTHORITY-PLAYBOOK.md
//
// Run this as the CURRENT authority (the bootstrap wallet, or a Squads proposal
// if authority is already a PDA). NEW_AUTHORITY is the destination pubkey — it
// can be a Squads vault PDA, which never signs a plain tx itself.
//
// Rotations are reversible (rotate back) EXCEPT a freeze to 111…1 — that one
// is permanent, so the destination is echoed before each send.
//
// Usage:
//   NEW_AUTHORITY=<multisig-pda> npx ts-node scripts/launch/rotate-authorities.ts          # amm+staking+crank
//   NEW_AUTHORITY=<multisig-pda> WHICH=amm            npx ts-node scripts/launch/rotate-authorities.ts
//   NEW_AUTHORITY=<multisig-pda> WHICH=calendar         npx ts-node scripts/launch/rotate-authorities.ts
//   NEW_AUTHORITY=11111111111111111111111111111111 WHICH=calendar npx ts-node ...  # FREEZE the schedule
//
// Requires `anchor build` so target/idl/*.json contain set_authority/setAuthority.

const WHICH = (process.env.WHICH || "all").toLowerCase(); // all | amm | staking | crank | calendar

function loadIdl(name: string): anchor.Idl {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", `${name}.json`), "utf-8"));
}

async function rotate(
  program: anchor.Program,
  accounts: Record<string, PublicKey>,
  label: string,
): Promise<void> {
  const method = (program.methods as any).setAuthority;
  if (!method) throw new Error(`${label}: setAuthority not in IDL — run 'anchor build'`);
  console.log(`${label}: rotating → ${process.env.NEW_AUTHORITY}${process.env.NEW_AUTHORITY === "11111111111111111111111111111111" ? "  ⚠ FREEZE — irreversible" : ""}`);
  const tx = await method(new PublicKey(process.env.NEW_AUTHORITY!)).accounts(accounts).rpc();
  console.log(`✓ ${label} authority rotated → ${process.env.NEW_AUTHORITY} (tx ${tx})`);
}

async function main() {
  const newAuthority = process.env.NEW_AUTHORITY;
  if (!newAuthority) throw new Error("NEW_AUTHORITY=<pubkey> is required (the multisig vault PDA)");
  new PublicKey(newAuthority); // validate

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployment = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
  );
  const mint = new PublicKey(deployment.mint);

  const tasks: Array<{ label: string; enabled: boolean; run: () => Promise<void> }> = [];

  // AMM authority
  tasks.push({
    label: "AMM",
    enabled: WHICH === "all" || WHICH === "amm",
    run: async () => {
      const idl = loadIdl("amm");
      const program = new anchor.Program(idl, provider);
      const [ammState] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), mint.toBuffer()],
        program.programId
      );
      await rotate(program, { authority: provider.wallet.publicKey, ammState }, "AMM");
    },
  });

  // staking pool authority
  tasks.push({
    label: "staking",
    enabled: WHICH === "all" || WHICH === "staking",
    run: async () => {
      const idl = loadIdl("staking");
      const program = new anchor.Program(idl, provider);
      const [pool] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), mint.toBuffer()],
        program.programId
      );
      await rotate(program, { authority: provider.wallet.publicKey, pool }, "staking");
    },
  });

  // crank-oracle bounty authority
  tasks.push({
    label: "crank-oracle",
    enabled: WHICH === "all" || WHICH === "crank",
    run: async () => {
      const idl = loadIdl("crank_oracle");
      const program = new anchor.Program(idl, provider);
      const [bountyConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        program.programId
      );
      await rotate(program, { authority: provider.wallet.publicKey, bountyConfig }, "crank-oracle");
    },
  });

  // market_calendar authority (the mutable calendar data: holidays + tz/DST)
  tasks.push({
    label: "calendar",
    enabled: WHICH === "calendar",
    run: async () => {
      const idl = loadIdl("crank_oracle");
      const program = new anchor.Program(idl, provider);
      const [marketCalendar] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_calendar")],
        program.programId
      );
      const cal = await (program.account as any).marketCalendar.fetchNullable(marketCalendar);
      if (!cal) throw new Error("calendar: market_calendar not initialized — run 'anchor run init-calendar'");
      const currentHolder = new PublicKey(cal.calendarAuthority);
      const builder = (program.methods as any)
        .setCalendarAuthority(new PublicKey(process.env.NEW_AUTHORITY!))
        .accounts({ calendarAuthority: currentHolder, marketCalendar });
      // Signed by the wallet this runs as — it must BE the current holder
      // (or run via a Squads proposal as the holder PDA).
      console.log(`calendar: rotating ${currentHolder.toBase58()} → ${process.env.NEW_AUTHORITY}${process.env.NEW_AUTHORITY === "11111111111111111111111111111111" ? "  ⚠ FREEZE — irreversible" : ""}`);
      const tx = await builder.rpc();
      console.log(`✓ calendar authority rotated → ${process.env.NEW_AUTHORITY} (tx ${tx})`);
    },
  });

  for (const task of tasks) {
    if (!task.enabled) continue;
    try {
      await task.run();
    } catch (err: any) {
      console.error(`✗ ${task.label} rotation failed: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  }

  console.log("\nDone. Verify with `anchor run check-authorities` (EXPECTED_AUTHORITY=<new holder>).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
