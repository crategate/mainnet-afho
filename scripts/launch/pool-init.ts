import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";
import { pubkey, writeDeploymentState } from "../lib/deployment-state";

// Freeze-curve params — mirror of FreezeParams::default in programs/staking/src/lib.rs.
const FREEZE_PARAMS = {
    capBps: 5000, minDays: 5, maxFloorDays: 40, maxSpanDays: 80,
    regimeBear: 1500, regimeBull: 6500, regimeFloorBps: 1500,
    popKneeBps: 3000, popFloorBps: 4000, graceDays: 2,
};

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // ── 1. Load staking program ──
    const stakingIdlPath = path.join(process.cwd(), "target", "idl", "staking.json");
    const stakingIdl = JSON.parse(fs.readFileSync(stakingIdlPath, "utf-8"));

    const stakingKeyPath = path.join(process.cwd(), "target", "deploy", "staking-keypair.json");
    if (!fs.existsSync(stakingKeyPath)) {
        throw new Error("staking-keypair.json not found. Run 'anchor build' first.");
    }
    const stakingKeyData = JSON.parse(fs.readFileSync(stakingKeyPath, "utf-8"));
    const stakingKeypair = Keypair.fromSecretKey(new Uint8Array(stakingKeyData));

    const stakingProgram = new anchor.Program(stakingIdl, provider);

    // ── 2. Load crank oracle program ID from its keypair ──
    const crankKeyPath = path.join(process.cwd(), "target", "deploy", "crank_oracle-keypair.json");
    if (!fs.existsSync(crankKeyPath)) {
        throw new Error("crank_oracle-keypair.json not found. Run 'anchor build' first.");
    }
    const crankKeyData = JSON.parse(fs.readFileSync(crankKeyPath, "utf-8"));
    const crankKeypair = Keypair.fromSecretKey(new Uint8Array(crankKeyData));
    const CRANK_PROGRAM_ID = crankKeypair.publicKey;

    console.log("Staking program:", stakingKeypair.publicKey.toBase58());
    console.log("Crank oracle program:", CRANK_PROGRAM_ID.toBase58());

    // ── 3. Load or prompt for AFHO mint ──
    // Option A: Read from a saved file (recommended after first deployment)
    const mintKeyPath = path.join(process.cwd(), "target", "deploy", "afho_token-keypair.json");
    let AFHO_MINT: PublicKey;

    if (fs.existsSync(mintKeyPath)) {
        const mintKeyData = JSON.parse(fs.readFileSync(mintKeyPath, "utf-8"));
        const mintKeypair = Keypair.fromSecretKey(new Uint8Array(mintKeyData));
        AFHO_MINT = mintKeypair.publicKey;
        console.log("Loaded AFHO mint:", AFHO_MINT.toBase58());
    } else {
        // Option B: Pass as command line argument
        const mintArg = process.argv[2];
        if (!mintArg) {
            console.error("Usage: npx ts-node scripts/launch/pool-init.ts <MINT_PUBKEY>");
            console.error("   Or deploy the token first with mint-create.ts to auto-detect");
            process.exit(1);
        }
        AFHO_MINT = new PublicKey(mintArg);
        console.log("Using mint from argument:", AFHO_MINT.toBase58());
    }
    const ammKeyPath = path.join(process.cwd(), "target", "deploy", "amm-keypair.json");
    let AMM_PROGRAM_ID: PublicKey;

    if (fs.existsSync(ammKeyPath)) {
        const ammKeyData = JSON.parse(fs.readFileSync(ammKeyPath, "utf-8"));
        const ammKeypair = Keypair.fromSecretKey(new Uint8Array(ammKeyData));
        AMM_PROGRAM_ID = ammKeypair.publicKey;
        console.log("AMM program:", AMM_PROGRAM_ID.toBase58());
    } else {
        throw new Error("amm-keypair.json not found. Run 'anchor build' first.");
    }
    // ── 4. Derive all PDAs ──
    const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), AFHO_MINT.toBuffer()],
        stakingProgram.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), poolPda.toBuffer()],
        stakingProgram.programId
    );
    const [rewardVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rewards"), poolPda.toBuffer()],
        stakingProgram.programId
    );
    const [penaltyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("penalties"), poolPda.toBuffer()],
        stakingProgram.programId
    );
    const [posrVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("posr"), poolPda.toBuffer()],
        stakingProgram.programId
    );
    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        CRANK_PROGRAM_ID
    );

    console.log("\nDerived accounts:");
    console.log("  Pool:", poolPda.toBase58());
    console.log("  Vault:", vaultPda.toBase58());
    console.log("  Reward Vault:", rewardVaultPda.toBase58());
    console.log("  Penalty Vault:", penaltyVaultPda.toBase58());
    console.log("  POSR Vault:", posrVaultPda.toBase58());
    console.log("  Market Status:", marketStatusPda.toBase58());

    writeDeploymentState({
        cluster: "devnet",
        mint: pubkey(AFHO_MINT),
        stakingProgram: pubkey(stakingProgram.programId),
        crankProgram: pubkey(CRANK_PROGRAM_ID),
        ammProgram: pubkey(AMM_PROGRAM_ID),
        pool: pubkey(poolPda),
        vault: pubkey(vaultPda),
        rewardVault: pubkey(rewardVaultPda),
        penaltyVault: pubkey(penaltyVaultPda),
        posrVault: pubkey(posrVaultPda),
        marketStatus: pubkey(marketStatusPda),
    });


    // ── 5. Initialize pool ──
    try {
        const tx = await stakingProgram.methods
            .initializePool(
                CRANK_PROGRAM_ID,
                30000,              // max multiplier 3.0x
                500,                // POSR tax 5%
                300,                // after hours penalty 3%
                600,               // closed penalty 6%
                1800,               // halted penalty 18
                AMM_PROGRAM_ID,
                FREEZE_PARAMS,
            )
            .accounts({
                authority: provider.wallet.publicKey,
                mint: AFHO_MINT,
                pool: poolPda,
                vault: vaultPda,
                rewardVault: rewardVaultPda,
                penaltyVault: penaltyVaultPda,
                posrVault: posrVaultPda,
                marketStatusPda,
                tokenProgram: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // TOKEN_2022
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        console.log("\n Pool initialized successfully!");
        console.log("Transaction:", tx);
    } catch (e: any) {
        if (e.message?.includes("already in use")) {
            console.log("\n!! Pool already initialized (this is fine).");
        } else {
            console.error("\n!! Failed to initialize pool:", e);
            process.exit(1);
        }
    }
}

main();