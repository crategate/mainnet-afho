import "dotenv/config";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { Keypair } from "@solana/web3.js";
import { resolveSolanaConfig } from "../lib/cluster";
import { derivePoolId } from "../lib/cpmm";
import { bs58Decode } from "../lib/jito";

// prep.ts — launch step 0, all home-side setup in ONE command (buyer repo
// retired 2026-09-29 — the 3% buy now rides inside the launch bundle, so
// there is no VPS buyer to configure or sync anymore):
//   1. claim the mint ADDRESS on-chain (Token-2022 mint + metadata, 0 supply,
//      metadata authority revoked) via mint-create.ts
//   2. print the pool PDA the launch bundle will create
//   3. print the buy wallet (BUYER_WALLET_KEY) and its exact funding needs
//
//   1. put your vanity keypair at target/deploy/afho_token-keypair.json
//   2. set BUYER_WALLET_KEY in .env (base58 secret or JSON byte array) and
//      fund that wallet per the numbers printed below
//   3. anchor run prep           (this)
//   4. anchor run launch         (… → launch-bundle: pool + 3% buy + freeze, atomic on mainnet; OPEN session required)

function buyWalletFromEnv(): Keypair | null {
    const raw = (process.env.BUYER_WALLET_KEY || "").trim();
    if (!raw) return null;
    try {
        return Keypair.fromSecretKey(raw.startsWith("[") ? new Uint8Array(JSON.parse(raw)) : bs58Decode(raw));
    } catch {
        return null;
    }
}

function main() {
  const mintKeypairPath = `${process.cwd()}/target/deploy/afho_token-keypair.json`;
  if (!fs.existsSync(mintKeypairPath)) {
    console.error("target/deploy/afho_token-keypair.json not found — put your vanity keypair there first.");
    process.exit(1);
  }

  const mint = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(mintKeypairPath, "utf8"))));
  const net = resolveSolanaConfig();
  console.log(`network: ${net.cluster}`);
  console.log(`AFHO mint: ${mint.publicKey.toBase58()}`);
  console.log(`launch bundle will create pool: ${derivePoolId(mint.publicKey, net.cluster).toBase58()}`);

  // Claim the mint on-chain (reuses mint-create.ts unchanged), on the same
  // network `solana config get` reports.
  const env = { ...process.env, ANCHOR_PROVIDER_URL: net.rpcUrl || process.env.ANCHOR_PROVIDER_URL || "" };
  const res = spawnSync("npx", ["ts-node", "scripts/launch/mint-create.ts"], { stdio: "inherit", env });
  if (res.status !== 0) {
    console.error(`\n✗ mint-create failed (exit ${res.status ?? "signal"}).`);
    process.exit(res.status ?? 1);
  }

  // Buy-wallet funding summary (the same numbers launch-bundle.ts enforces).
  const usdcToLp = Number(process.env.USDC_TO_LP || 2000);
  const buyWhole = Math.ceil((usdcToLp * 18) / 100);
  const buy = buyWalletFromEnv();
  console.log("\n  ── BUY WALLET (the 3% launch buy + frozen lots — launch-bundle.ts) ────");
  if (!buy) {
    console.log("  !! BUYER_WALLET_KEY is not set/parseable — set it in .env before 'anchor run launch'.");
  } else {
    console.log(`  buy wallet: ${buy.publicKey.toBase58()}`);
  }
  console.log(`  fund it with ≥ ${buyWhole} USDC  (0.18 × USDC_TO_LP=${usdcToLp})`);
  console.log(`  fund it with ≥ ~0.03 SOL (fees + 4 stake-account rents)`);
  console.log("  ─────────────────────────────────────────────────────────────────────");

  console.log("\n✓ prep complete. Next: fund the buy wallet (above), then 'anchor run launch'.");
}

main();
