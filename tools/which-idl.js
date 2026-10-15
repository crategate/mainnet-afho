#!/usr/bin/env node
// Correct derivation: idlAddress = createWithSeed(findProgramAddress([], pid)[0], "anchor:idl", pid)
const { PublicKey } = require('@solana/web3.js');
(async () => {
  const candidates = {
    amm: 'AU19M8ELLh7h4GMpmj9ZKjF4NNXmYK6aiVoLs9yvnuRi',
    staking: 'AR1Wyj3CLhcxB5jAiqFn5xHFamcjdNiiYv9gQLCVvTZp',
    crank_oracle: 'DVqxnBUD3KRMfw5Lw8GZotW9ENcMgUu96r7pxZCCcfCH',
    sbod_devnet: 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2',
    sbod_mainnet: 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv',
    quote_program: 'orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz',
  };
  const target = '5zuXXR9LUbb9CzJbg8B2WfXstNz353v7Rr38E42yddoJ';
  for (const [name, pid] of Object.entries(candidates)) {
    const p = new PublicKey(pid);
    const [base] = await PublicKey.findProgramAddress([], p);
    const idl = await PublicKey.createWithSeed(base, 'anchor:idl', p);
    console.log(name.padEnd(16), idl.toBase58(), idl.toBase58() === target ? '<== MATCH' : '');
  }
})();
