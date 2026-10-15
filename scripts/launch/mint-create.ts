import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import {
    PublicKey,
    SystemProgram,
    Transaction,
    Keypair,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    ExtensionType,
    TOKEN_2022_PROGRAM_ID,
    getMintLen,
    TYPE_SIZE,
    LENGTH_SIZE,
    createInitializeMetadataPointerInstruction,
    createInitializeMintInstruction,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateAuthorityInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { pubkey, writeDeploymentState } from "../lib/deployment-state";

// mint-create.ts — launch phase 1: create the AFHO mint (Token-2022, metadata
// pointer) with ZERO supply and nothing revoked yet.
//
// Launch sequence (old mint-launch.ts split 2026-09-09; trust rationale in
// MAINNET_CHECKLIST §5):
//   1. mint-create    this — mint account + metadata, 0 supply, METADATA
//                     AUTHORITY REVOKED in the same tx (name/symbol/URI are
//                     final from day one — triple-check them before running)
//   2. init           crank oracle init + market calendar + bounty
//   3. amm-init       staking pool + AMM state + EMPTY vaults
//   4. fund-launch    THE supply tx: 80% mints straight into afho_vault,
//                     20% into the pool seed ATA, mint authority revoked in
//                     the same tx — the authority wallet never holds supply
//   6. create-pool    Raydium CPMM from the seed ATA (+ USDC leg)
//   7. set-pools      pin CPMM + SOL/USDC pools, claim ALT
//   8. burn-lp        final step — executes by default (SKIP_BURN=1 at the launch level for Phase-0 rehearsal)
async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    console.log(" Starting Mint Creation (supply stays at 0 until fund-launch)...");

    // Crank program (market status PDA source — same as pre-split mint-launch)
    const crankKeypairPath = path.join(process.cwd(), "target", "deploy", "crank_oracle-keypair.json");
    const crankKeyData = JSON.parse(fs.readFileSync(crankKeypairPath, "utf-8"));
    const oracleCrankProgramId = Keypair.fromSecretKey(new Uint8Array(crankKeyData)).publicKey;

    // 1. Load or generate mint keypair
    const mintKeypairPath = path.join(process.cwd(), "target", "deploy", "afho_token-keypair.json");
    let mint: Keypair;
    if (fs.existsSync(mintKeypairPath)) {
        const keyData = JSON.parse(fs.readFileSync(mintKeypairPath, "utf-8"));
        mint = Keypair.fromSecretKey(new Uint8Array(keyData));
        console.log(` Loaded existing Mint: ${mint.publicKey.toBase58()}`);
    } else {
        mint = Keypair.generate();
        fs.writeFileSync(mintKeypairPath, JSON.stringify(Array.from(mint.secretKey)));
        console.log(` Generated new Mint: ${mint.publicKey.toBase58()}`);
    }

    const decimals = 9;

    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        oracleCrankProgramId
    );

    writeDeploymentState({
        cluster: (process.env.ANCHOR_PROVIDER_URL ?? "").includes("mainnet") ? "mainnet" : "devnet",
        mint: pubkey(mint.publicKey),
        crankProgram: pubkey(oracleCrankProgramId),
        marketStatus: pubkey(marketStatusPda),
    });

    // 2. Token metadata configuration
    // additionalMetadata keys (on-chain, immutable from this tx) are what
    // scanners (GoPlus/TokenSniffer/Birdeye) display as the token's socials.
    // Convention: "website" / "twitter" / "telegram" — keep the SAME values in
    // the off-chain JSON at the uri (external_url/twitter/telegram) so wallets
    // AND scanners both resolve. The uri itself is frozen at mint-create: if
    // you change that JSON, re-upload to IPFS and update `uri` here BEFORE
    // running this script.
    const metadata: TokenMetadata = {
        mint: mint.publicKey,
        name: 'After Hours',
        symbol: 'AFHO',
        uri: 'https://copper-quick-koi-488.mypinata.cloud/ipfs/bafkreiahhuhfsqbxrnver3pjnbgcgtamgeewc4lowkrbfiisi5prpgglfu',
        additionalMetadata: [
            ['description', 'a defi coin bound by tradfi hours'],
            ['website', 'https://afho.io'],
            ['twitter', 'https://x.com/afhoio'],
            ['telegram', 'https://t.me/afhoio'],
        ],
    };
    const metadataLen = pack(metadata).length + TYPE_SIZE + LENGTH_SIZE;
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);

    const lamports = await connection.getMinimumBalanceForRentExemption(metadataLen + mintLen);

    // ==========================================
    // STEP 1: INITIALIZE MINT & EXTENSIONS
    // (no mintTo — supply is minted in fund-launch's single tx; metadata
    // authority is revoked below, in this same tx, so the reservation is
    // immutable from the moment it lands)
    // ==========================================
    console.log(" Initializing Mint and Extensions...");
    const initMintTx = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: mint.publicKey,
            space: mintLen,
            lamports: lamports,
            programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMetadataPointerInstruction(
            mint.publicKey,
            wallet.publicKey,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(
            mint.publicKey,
            decimals,
            wallet.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
        ),
        createInitializeInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            mint: mint.publicKey,
            metadata: mint.publicKey,
            mintAuthority: wallet.publicKey,
            name: metadata.name,
            symbol: metadata.symbol,
            uri: metadata.uri,
            updateAuthority: wallet.publicKey
        }),
        // Revoke metadata update authority in the SAME tx: name/symbol/URI
        // become immutable the moment the mint exists. No edit path after
        // this — a mistake means a new mint.
        createUpdateAuthorityInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            metadata: mint.publicKey,
            oldAuthority: wallet.publicKey,
            newAuthority: null,
        })
    );

    try {
        const sig1 = await sendAndConfirmTransaction(connection, initMintTx, [wallet.payer, mint], { skipPreflight: true, commitment: "confirmed" });
        console.log(` Mint initialized (supply 0, metadata immutable)! Signature: ${sig1}`);
        console.log(" Metadata update authority revoked in the same tx — name/symbol/URI are final.");
        console.log(" Next: anchor run init");
    } catch (e) {
        console.log("Mint already initialized or failed:   ", e);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
