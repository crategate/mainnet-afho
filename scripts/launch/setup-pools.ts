import { setCpmmPool } from "./set-cpmm-pool";
import { setSolUsdcPool } from "./set-sol-usdc-pool";
import { ensureClaimAlt } from "./create-claim-alt";

async function main() {
    await setCpmmPool();
    await setSolUsdcPool();
    const alt = await ensureClaimAlt();
    console.log(`\n Pool setup complete. Claim lookup table: ${alt}`);
    console.log(" SOL bond claims now send as v0 transactions with a 400k CU limit.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
