import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { usdcMintFor } from "../lib/cpmm";
import { resolveSolanaConfig } from "../lib/cluster";

// Prints the Raydium CPMM pool's state: pool/vault/LP-mint addresses, the
// AFHO + USDC vault balances, and the implied AFHO/USDC price. Reads the
// addresses written by create-pool (createPool) into deployment.json.
async function main() {
    const connection = new Connection(
        process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com"
    );
    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const mint = new PublicKey(deployment.mint);
    // Cluster-aware via the shared helper (mainnet EPjFW…, devnet USDCoct…);
    // an explicit env still wins for one-offs.
    const usdcMint = usdcMintFor(
        resolveSolanaConfig().cluster,
        process.env.USDC_MINT || process.env.DEVNET_USDC_MINT
    );
    const cpmmProgram = new PublicKey(deployment.raydiumProgram);
    const pool = new PublicKey(deployment.raydiumPool);
    const config = new PublicKey(deployment.raydiumAmmConfig);

    const [vaultAfho] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()],
        cpmmProgram
    );
    const [vaultUsdc] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
        cpmmProgram
    );
    const [lpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_lp_mint"), pool.toBuffer()],
        cpmmProgram
    );

    const afhoBal = await getAccount(connection, vaultAfho, "confirmed", TOKEN_2022_PROGRAM_ID);
    const usdcBal = await getAccount(connection, vaultUsdc, "confirmed", TOKEN_PROGRAM_ID);
    const lp = await connection.getTokenSupply(lpMint);

    const afhoWhole = Number(afhoBal.amount) / 1e9;
    const usdcWhole = Number(usdcBal.amount) / 1e6;

    console.log("Raydium CPMM pool:", pool.toBase58());
    console.log("  program:    ", cpmmProgram.toBase58());
    console.log("  amm_config: ", config.toBase58());
    console.log("  AFHO vault: ", vaultAfho.toBase58(), "→", afhoWhole.toLocaleString(), "AFHO");
    console.log("  USDC vault: ", vaultUsdc.toBase58(), "→", usdcWhole.toLocaleString(), "USDC");
    console.log("  LP mint:    ", lpMint.toBase58(), "→ supply", Number(lp.value.amount).toLocaleString());
    if (afhoWhole > 0) {
        console.log("  Implied price: 1 AFHO =", (usdcWhole / afhoWhole).toFixed(6), "USDC");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
