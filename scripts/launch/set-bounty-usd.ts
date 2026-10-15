import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Authority-gated live update of the USD-priced keeper bounty
// (crank-oracle set_bounty_usd). USDC raw units (6 dp) — $0.75 = 750_000.
// Usage: `anchor run set-bounty-usd` or `npx ts-node scripts/launch/set-bounty-usd.ts 750000`.
async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const rawArg = process.argv[2];
  if (!rawArg) {
    console.error(
      "Usage: npx ts-node scripts/launch/set-bounty-usd.ts <USDC_RAW_6DP>  (e.g. 750000 = $0.75)"
    );
    process.exit(1);
  }
  const newUsdRaw = BigInt(rawArg);
  if (newUsdRaw <= 0n) {
    console.error("USDC raw amount must be positive");
    process.exit(1);
  }

  const idlPath = path.join(
    process.cwd(),
    "target",
    "idl",
    "crank_oracle.json"
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  const [bountyConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bounty_config")],
    program.programId
  );

  const tx = await program.methods
    .setBountyUsd(new anchor.BN(newUsdRaw.toString()))
    .accounts({
      authority: provider.wallet.publicKey,
      bountyConfig: bountyConfigPda,
    })
    .rpc();
  console.log(
    ` USD bounty set to $${(Number(newUsdRaw) / 1_000_000).toFixed(
      2
    )} (${newUsdRaw} raw) — tx ${tx}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
