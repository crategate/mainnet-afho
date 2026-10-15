import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idl = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), "target", "idl", "crank_oracle.json"), "utf-8"));
    const program = new anchor.Program(idl, provider);

    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")], program.programId);
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")], program.programId);

    // Default 0.5 SOL ≈ 100 cranks at $0.50 each; override: `anchor run fund-bount -- 0.25`
    const amountSol = parseFloat(process.argv[2] ?? "0.5");
    if (!(amountSol > 0)) throw new Error(`invalid amount: ${process.argv[2]}`);
    const amount = new anchor.BN(amountSol * anchor.web3.LAMPORTS_PER_SOL);

    // Preflight: fund_bounty is authority-gated — a payer that isn't
    // bounty_config.authority fails with 0x1773 InvalidAuthority. Check
    // BEFORE sending so the failure names the fix instead of a hex code.
    // (NB: Program camelCases account names for the coder — use the account
    // namespace, not coder.accounts.decode("BountyConfig").)
    const cfg = await (program.account as any).bountyConfig.fetchNullable(bountyConfigPda);
    if (!cfg) throw new Error(`bounty_config ${bountyConfigPda.toBase58()} not found — run \`anchor run init\` first`);
    const authority = cfg.authority as PublicKey;
    if (!authority.equals(provider.wallet.publicKey)) {
        console.error(`✗ payer ${provider.wallet.publicKey.toBase58()} is not the bounty authority.`);
        console.error(`    on-chain authority : ${authority.toBase58()}`);
        console.error(`  You probably don't need this instruction at all — the vault is a plain`);
        console.error(`  lamport PDA, so any wallet can top it up directly:`);
        console.error(`    solana transfer ${bountyVaultPda.toBase58()} ${amountSol} --url devnet`);
        console.error(`  To keep using fund_bounty, rotate the authority (signed by ${authority.toBase58()}):`);
        console.error(`    NEW_AUTHORITY=${provider.wallet.publicKey.toBase58()} WHICH=crank npx ts-node scripts/launch/rotate-authorities.ts`);
        process.exit(1);
    }

    const tx = await program.methods
        .fundBounty(amount)
        .accounts({
            payer: provider.wallet.publicKey,
            bountyConfig: bountyConfigPda,
            bountyVault: bountyVaultPda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    console.log(` Bounty vault funded with ${amountSol} SOL:`, tx);
}

main();
