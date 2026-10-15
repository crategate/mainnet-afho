import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { readDeploymentState } from "../lib/deployment-state";

// check-authorities.ts — post-launch invariant check: every protocol
// authority is the wallet this runs as (or EXPECTED_AUTHORITY once they've
// been rotated onto the multisig).
//
//   anchor run check-authorities                                # expect launch wallet
//   EXPECTED_AUTHORITY=<squads-vault-pda> anchor run check-authorities   # post-rotation
//
// Why: launch steps historically ran under mixed wallets (initialize.ts once
// hardcoded id.json while Anchor.toml pointed elsewhere), and a re-launch
// silently keeps the OLD on-chain authority — surfacing much later as
// 0x1773 InvalidAuthority on fund_bounty / set_bounty_usd / set_keeper.
// `anchor run launch` runs this as its final step so a wrong-authority
// launch fails loudly at launch time, not days later.
//
// Authorities checked:
//   crank_oracle  BountyConfig.authority  (global PDA, not per-mint)
//   amm           AmmState.authority      (per-mint)   — also prints the keeper
//   staking       StakePool.authority     (per-mint)
//   crank_oracle  MarketCalendar.calendar_authority (trade hours + holidays
//                  — ONE knob; EXPECTED_CALENDAR=<pubkey> to expect a different
//                  holder, e.g. after freezing to the burn address)
//
// Read-only: fetches accounts, sends nothing.

function loadIdl(name: string): anchor.Idl {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", `${name}.json`), "utf-8"));
}

interface Check {
  label: string;
  programName: string;
  accountName: string; // anchor camelCase account namespace
  pda: PublicKey;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const expected = process.env.EXPECTED_AUTHORITY
    ? new PublicKey(process.env.EXPECTED_AUTHORITY)
    : provider.wallet.publicKey;

  const deployment = readDeploymentState();
  if (!deployment.mint) {
    throw new Error("app/public/deployment.json has no mint — run `anchor run prep` first");
  }
  const mint = new PublicKey(deployment.mint);

  const crank = new anchor.Program(loadIdl("crank_oracle"), provider);
  const amm = new anchor.Program(loadIdl("amm"), provider);
  const staking = new anchor.Program(loadIdl("staking"), provider);

  const [bountyConfig] = PublicKey.findProgramAddressSync([Buffer.from("bounty_config")], crank.programId);
  const [ammState] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_state"), mint.toBuffer()],
    amm.programId
  );
  const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), mint.toBuffer()], staking.programId);

  const [marketCalendar] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_calendar")],
    crank.programId
  );

  const checks: Check[] = [
    { label: "crank_oracle BountyConfig", programName: "crank", accountName: "bountyConfig", pda: bountyConfig },
    { label: "amm AmmState              ", programName: "amm", accountName: "ammState", pda: ammState },
    { label: "staking StakePool         ", programName: "staking", accountName: "stakePool", pda: stakePool },
  ];

  // Calendar authorities: expected = launch wallet unless an override env is
  // set (post-rotation to multisig / freeze to the burn address).
  const calExpected = process.env.EXPECTED_CALENDAR
    ? new PublicKey(process.env.EXPECTED_CALENDAR)
    : expected;

  console.log(`wallet:    ${provider.wallet.publicKey.toBase58()}`);
  console.log(`expected:  ${expected.toBase58()}${process.env.EXPECTED_AUTHORITY ? "  (EXPECTED_AUTHORITY)" : "  (launch wallet)"}`);
  console.log(`mint:      ${mint.toBase58()}\n`);

  let failed = false;
  // (calendar checks below reference `failed` — declared before the loop)
  for (const c of checks) {
    const program = c.programName === "crank" ? crank : c.programName === "amm" ? amm : staking;
    const label = c.label.trim();
    try {
      const acc = await (program.account as any)[c.accountName].fetchNullable(c.pda);
      if (!acc) {
        console.error(`✗ ${label}: account not found (${c.pda.toBase58()}) — init step missing or wrong mint?`);
        failed = true;
        continue;
      }
      const authority = new PublicKey(acc.authority);
      const ok = authority.equals(expected);
      console.log(`${ok ? "✓" : "✗"} ${label}: authority ${authority.toBase58()}${ok ? "" : `  ≠ expected ${expected.toBase58()}`}`);
      if (acc.keeper !== undefined) {
        console.log(`  amm keeper (operational hot wallet — NOT the multisig): ${new PublicKey(acc.keeper).toBase58()}`);
      }
      if (!ok) failed = true;
    } catch (err: any) {
      console.error(`✗ ${label}: fetch failed — ${err?.message ?? err}`);
      failed = true;
    }
  }

  // Calendar authorities (injected after the loop so `failed` aggregates)
  await (async () => {
    try {
      const cal = await (crank.account as any).marketCalendar.fetchNullable(marketCalendar);
      if (!cal) {
        console.error(`✗ market_calendar: account not found (${marketCalendar.toBase58()}) — run 'anchor run init-calendar'`);
        failed = true;
        return;
      }
      const c0 = new PublicKey(cal.calendarAuthority);
      const okC = c0.equals(calExpected);
      console.log(`${okC ? "✓" : "✗"} market_calendar (hours + holidays): ${c0.toBase58()}${okC ? "" : `  ≠ expected ${calExpected.toBase58()}`}`);
      if (!okC) failed = true;
    } catch (err: any) {
      console.error(`✗ market_calendar: fetch failed — ${err?.message ?? err}`);
      failed = true;
    }
  })();

  if (failed) {
    console.error(
      `\n✗ authority check FAILED. Either re-run the launch from the right wallet, or rotate:\n` +
      `    NEW_AUTHORITY=${expected.toBase58()} npx ts-node scripts/launch/rotate-authorities.ts   # signed by each CURRENT authority\n` +
      `  (after rotating to the multisig, re-run with EXPECTED_AUTHORITY=<multisig pda>)`
    );
    process.exit(1);
  }
  console.log(`\n✓ all protocol authorities match ${process.env.EXPECTED_AUTHORITY ? "EXPECTED_AUTHORITY" : "the launch wallet"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
