import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Transaction, Keypair } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    getMint,
    getAccount,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createMintToInstruction,
    createSetAuthorityInstruction,
    AuthorityType,
} from "@solana/spl-token";
import { readDeploymentState } from "../lib/deployment-state";

// fund-launch.ts — launch phase 2: THE one supply transaction. Run AFTER
// amm-init (the afho_vault must exist).
//
// Old flow (mint-launch.ts + amm-init's 100%-of-balance sweep): 1B AFHO minted
// into the authority wallet, then swept into the vault — the wallet held 75%
// of supply at the moment the pool became visible, a top-holder concentration
// flag on every screener. New flow (MAINNET_CHECKLIST §5): the vaults are born
// EMPTY (amm-init) and this script mints directly into the final destinations:
//
//   mintTo(afho_vault,  80%)  ── program-custodied bond-desk inventory
//   mintTo(seed ATA,    20%)  ── dedicated pool seed (create-pool pulls it)
//   revoke mint authority    ── supply permanently capped, same tx
// (metadata authority was already revoked at mint-create — immutable since
// reservation — so this tx only kills the mint authority)
//
// The authority wallet never holds supply: screeners snapshot pool 20% (LP
// burnable via burn-lp), vault 80% (program-owned, no authority sweep exists),
// wallet ~0%. Supply is FINALIZED (never launch config): 1B total, 20% →
// 200M to the pool seed (see the constants in §5).
async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    // ── 1. Mint (created by mint-create) ──
    const mintKeypairPath = path.join(process.cwd(), "target", "deploy", "afho_token-keypair.json");
    if (!fs.existsSync(mintKeypairPath)) {
        throw new Error("afho_token-keypair.json not found. Run 'anchor run mint-create' first.");
    }
    const AFHO_MINT = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(mintKeypairPath, "utf-8")))
    ).publicKey;
    console.log(" AFHO mint:", AFHO_MINT.toBase58());

    // ── 2. Vault + amm_state from deployment.json (amm-init must have run) ──
    const deployment = readDeploymentState();
    if (!deployment.ammAfhoVault || !deployment.ammState) {
        throw new Error("ammAfhoVault/ammState missing from deployment.json. Run 'anchor run amm-init' first.");
    }
    const AFHO_VAULT = new PublicKey(deployment.ammAfhoVault);
    const AMM_STATE = new PublicKey(deployment.ammState);

    // ── 3. Mint-state checks — fail closed BEFORE anything is sent ──
    const mintInfo = await getMint(connection, AFHO_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
    const decimals = mintInfo.decimals;
    if (mintInfo.mintAuthority === null) {
        throw new Error("Mint authority is already revoked — supply can never be minted. Nothing to do (already funded?).");
    }
    if (!mintInfo.mintAuthority.equals(wallet.publicKey)) {
        throw new Error(
            `Mint authority is ${mintInfo.mintAuthority.toBase58()}, not this wallet ` +
            `(${wallet.publicKey.toBase58()}). Run fund-launch from the mint-authority wallet.`
        );
    }
    if (mintInfo.supply > 0n) {
        throw new Error(`Mint supply is ${mintInfo.supply} (expected 0) — re-running would double-mint. Aborting.`);
    }

    // ── 4. Vault sanity: exists, Token-2022, owned by amm_state, still empty ──
    let vaultAcct;
    try {
        vaultAcct = await getAccount(connection, AFHO_VAULT, "confirmed", TOKEN_2022_PROGRAM_ID);
    } catch (e) {
        throw new Error(`AFHO vault ATA ${AFHO_VAULT.toBase58()} not found — run 'anchor run amm-init' first. (${e instanceof Error ? e.message : e})`);
    }
    if (!vaultAcct.owner.equals(AMM_STATE)) {
        throw new Error(`Vault is owned by ${vaultAcct.owner.toBase58()}, not amm_state ${AMM_STATE.toBase58()} — deployment.json is stale.`);
    }
    if (vaultAcct.amount > 0n) {
        throw new Error("Vault already holds AFHO — refusing to fund twice.");
    }

    // ── 5. Split (finalized constants — never launch config) ──
    const totalWhole = 1_000_000_000n; // 1B whole tokens
    const lpPct = 20n;                 // 20% → 200M to the pool seed
    const vaultWhole = (totalWhole * (100n - lpPct)) / 100n;
    const lpWhole = totalWhole - vaultWhole;
    const raw = 10n ** BigInt(decimals);
    const vaultRaw = vaultWhole * raw;
    const lpRaw = lpWhole * raw;
    console.log(` Split: ${vaultWhole.toLocaleString("en-US")} AFHO → vault | ${lpWhole.toLocaleString("en-US")} AFHO → pool seed`);

    // ── 6. One tx: fund both destinations + revoke both authorities ──
    const seedAta = getAssociatedTokenAddressSync(AFHO_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey, seedAta, wallet.publicKey, AFHO_MINT, TOKEN_2022_PROGRAM_ID
        ),
        createMintToInstruction(AFHO_MINT, AFHO_VAULT, wallet.publicKey, vaultRaw, [], TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(AFHO_MINT, seedAta, wallet.publicKey, lpRaw, [], TOKEN_2022_PROGRAM_ID),
        // Revoke mint authority: supply permanently capped (freeze authority
        // was already null at mint-create; metadata was also revoked there).
        createSetAuthorityInstruction(
            AFHO_MINT, wallet.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID
        )
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    const sig = await provider.sendAndConfirm(tx);
    console.log(` Funded + authorities revoked! Tx: ${sig}`);
    console.log(`   vault:    ${AFHO_VAULT.toBase58()} (+${vaultRaw} raw)`);
    console.log(`   seed ATA: ${seedAta.toBase58()} (+${lpRaw} raw)`);
    console.log(" Mint authority revoked — supply permanently capped (metadata was already immutable from mint-create).");
    console.log(" Next: anchor run launch-bundle (create-pool is recovery tooling only)");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
