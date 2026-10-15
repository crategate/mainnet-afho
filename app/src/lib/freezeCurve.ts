// Client mirror of the staking program's freeze curve + base multiplier
// (programs/staking/src/lib.rs). The on-chain instruction is the ONLY
// authority — this mirror previews quotes; move them together.

export interface FreezeParamsLike {
    freezeCapBps: number;
    freezeMinDays: number;
    freezeMaxFloorDays: number;
    freezeMaxSpanDays: number;
    freezeRegimeBear: number;
    freezeRegimeBull: number;
    freezeRegimeFloorBps: number;
    freezePopKneeBps: number;
    freezePopFloorBps: number;
    freezeGraceDays: number;
}

// Default on-chain params (mirror of FreezeParams::default in the staking
// program; pools init with these today).
export const FREEZE_DEFAULTS: FreezeParamsLike = {
    freezeCapBps: 5000,
    freezeMinDays: 5,
    freezeMaxFloorDays: 40,
    freezeMaxSpanDays: 80,
    freezeRegimeBear: 1500,
    freezeRegimeBull: 6500,
    freezeRegimeFloorBps: 1500,
    freezePopKneeBps: 3000,
    freezePopFloorBps: 4000,
    freezeGraceDays: 2,
};

// Base weight multiplier: 1.0x day 0 → 3.0x saturating (half-range at 60d).
export function baseMultiplierBps(elapsedDays: number, maxBps = 30000): number {
    const range = Math.max(0, maxBps - 10000);
    return 10000 + Math.floor((elapsedDays * range) / (elapsedDays + 60));
}

export function freezeRegimeBps(momentum: number, p: FreezeParamsLike): number {
    if (momentum <= p.freezeRegimeBear) return 10000;
    if (momentum >= p.freezeRegimeBull) return p.freezeRegimeFloorBps;
    const span = p.freezeRegimeBull - p.freezeRegimeBear;
    return Math.max(
        p.freezeRegimeFloorBps,
        10000 - Math.floor(((10000 - p.freezeRegimeFloorBps) * (momentum - p.freezeRegimeBear)) / span),
    );
}

export function freezeMaxDays(regimeBps: number, p: FreezeParamsLike): number {
    return p.freezeMaxFloorDays + Math.floor((p.freezeMaxSpanDays * regimeBps) / 10000);
}

// Concave saturating ramp: 0 at day 0, 10000 at maxDays, 7500 at the midpoint.
export function freezeLengthBps(days: number, maxDays: number): number {
    if (maxDays <= 0 || days <= 0) return 0;
    const d = Math.min(days, maxDays);
    return Math.floor((10000 * d * (2 * maxDays - d)) / (maxDays * maxDays));
}

export function freezePopularityBps(frozenShareBps: number, p: FreezeParamsLike): number {
    if (frozenShareBps <= p.freezePopKneeBps) return 10000;
    return Math.max(p.freezePopFloorBps, 10000 - (frozenShareBps - p.freezePopKneeBps));
}

export function freezeBonusBps(
    days: number,
    momentum: number,
    frozenShareBps: number,
    p: FreezeParamsLike,
): number {
    const regime = freezeRegimeBps(momentum, p);
    const maxDays = freezeMaxDays(regime, p);
    const length = freezeLengthBps(days, maxDays);
    const pop = freezePopularityBps(frozenShareBps, p);
    const bonus = Math.floor(
        (p.freezeCapBps * regime * length * pop) / 1e12,
    );
    return Math.min(bonus, p.freezeCapBps);
}

// Slider range for the freeze UI: allowed span + cap at this momentum.
// Popularity (frozenShareBps) scales the BONUS, never the allowed range,
// so freezeQuote takes no share argument.
export function freezeQuote(
    momentum: number,
    p: FreezeParamsLike,
): { minDays: number; maxDays: number; capBps: number } {
    const regime = freezeRegimeBps(momentum, p);
    return {
        minDays: p.freezeMinDays,
        maxDays: freezeMaxDays(regime, p),
        capBps: p.freezeCapBps,
    };
}
