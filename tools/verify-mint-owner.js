const { Connection, PublicKey } = require("@solana/web3.js");
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Old mint (first successful deployment)
  const oldMint = await conn.getParsedAccountInfo(new PublicKey("FR3vnh5Sn7k89vTe4QzjsnHG97pkPAx6bPDYiN5hRhzA"));
  console.log("OLD mint FR3vnh5 owner:", oldMint.value?.owner.toBase58());
  await sleep(1200);
  // Current (broken) mint — read from deployment.json
  const deployment = require("../app/public/deployment.json");
  const newMint = await conn.getParsedAccountInfo(new PublicKey(deployment.mint));
  console.log("NEW mint", deployment.mint, "owner:", newMint.value?.owner.toBase58());
  await sleep(1200);
  // Old pool AFHO vault owner — which token program does the CPMM vault use?
  const oldVault = await conn.getAccountInfo(new PublicKey("2ZgHiHpH2WyB6KcHShCKirqSmBQPsk4yMnVgbRjz63mV"));
  console.log("OLD pool AFHO vault owner:", oldVault?.owner.toBase58());
})();
