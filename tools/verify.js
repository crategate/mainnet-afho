const { Connection, PublicKey } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const RPC = "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");

const OLD_POOL = "3D8rdgFw1qHhuZJQomatnyjEjXGjmwSzDaMiG7CyoF7a";
const OLD_MINT = "FR3vnh5Sn7k89vTe4QzjsnHG97pkPAx6bPDYiN5hRhzA";
const NEW_MINT = "BswEa6PqSWkomDaD5Y3fG3VuS7QB4TTBpbzQRQ3XMAU1";
const RAY_PROG = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";
const USDC_MINT = "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"; // current canonical devnet USDC (old version used 4zMMC9...)

const vaultPda = (pool, mint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), new PublicKey(pool).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(RAY_PROG)
  )[0];

const bal = async (addr, prog) => {
  try {
    const b = await conn.getTokenAccountBalance(new PublicKey(addr), "confirmed");
    return `${b.value.uiAmountString} (${b.value.amount} raw)`;
  } catch (e) {
    return `NOT FOUND (${e.constructor.name})`;
  }
};

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log("=== OLD POOL (3D8rdg...) vaults, derived with OLD mint ===");
  console.log("AFHO vault:", vaultPda(OLD_POOL, OLD_MINT).toBase58(), "→", await bal(vaultPda(OLD_POOL, OLD_MINT), TOKEN_2022_PROGRAM_ID));
  console.log("USDC vault:", vaultPda(OLD_POOL, USDC_MINT).toBase58(), "→", await bal(vaultPda(OLD_POOL, USDC_MINT), TOKEN_PROGRAM_ID));
  await sleep(1500);

  console.log("\n=== OLD POOL vaults, derived with NEW mint (what deployment.json now implies) ===");
  console.log("AFHO vault:", vaultPda(OLD_POOL, NEW_MINT).toBase58(), "→", await bal(vaultPda(OLD_POOL, NEW_MINT), TOKEN_2022_PROGRAM_ID));
  await sleep(1500);

  console.log("\n=== Where is the other 750M of new supply? ===");
  const ammAfho = "B7pZZeHJ5BZWQ1ryjGHuRHmZQGdtGfi8Wnk5zsm9P1BC";
  const stakingVault = "CshUgg9u6FKcaTBMFG9325gifKVkvCXEQQqpTXJTxUx2";
  console.log("ammAfhoVault:", ammAfho, "→", await bal(ammAfho, TOKEN_2022_PROGRAM_ID));
  await sleep(1500);
  console.log("staking vault:", stakingVault, "→", await bal(stakingVault, TOKEN_2022_PROGRAM_ID));
  await sleep(1500);

  console.log("\n=== Largest holders (retry) ===");
  for (let i = 0; i < 4; i++) {
    try {
      const r = await conn.getTokenLargestAccounts(new PublicKey(NEW_MINT));
      for (const h of r.value) console.log(h.address.toBase58(), "→", (Number(h.amount) / 1e9).toLocaleString(), "AFHO");
      break;
    } catch (e) {
      console.log("retry", i + 1, "-", e.message.split("\n")[0]);
      await sleep(3000);
    }
  }
})();
