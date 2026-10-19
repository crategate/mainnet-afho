// launch-steps.ts — the single source of the launch-chain order. Consumed by
// launch.ts (plain sequential runner) and deploy-wizard.ts (interactive
// wrapper). Order is load-bearing: check-authorities runs BEFORE fund-launch
// (genesis-race guard) and again at the end; web-dist is last because the
// build copies the deployment.json this chain just wrote.

export interface Step {
    name: string;
    script: string;
    label: string;
}

export const STEPS: Step[] = [
    { name: "init", script: "init", label: "crank oracle init + frozen market calendar + bounty config (breaker venues are immutable constants)" },
    { name: "amm-init", script: "amm-init", label: "staking pool + AMM state + empty vaults (+ authority verify)" },
    { name: "check-authorities", script: "check-authorities", label: "GENESIS-RACE GUARD: verify authorities BEFORE any supply moves" },
    { name: "fund-launch", script: "fund-launch", label: "THE supply tx (80% vault / 20% seed, revoke mint authority)" },
    { name: "launch-bundle", script: "launch-bundle", label: "JITO BUNDLE: create CPMM pool + 3% buy (0.18×USDC_TO_LP) + 3×5M staked+FROZEN lots, half liquid — atomic on mainnet, OPEN session required" },
    { name: "set-pools", script: "set-pools", label: "pin CPMM + SOL/USDC pools, claim ALT" },
    { name: "check-authorities", script: "check-authorities", label: "final authority invariant" },
    { name: "burn-lp", script: "burn-lp", label: "burn 100% LP (default behavior — SKIP_BURN=1 to keep LP recoverable)" },
    { name: "web-dist", script: "web-dist", label: "web bundle: npm run build in app/ (typecheck gate) + zip dist → app/dist/dep.zip for upload — carries the deployment.json this chain just wrote" },
];
