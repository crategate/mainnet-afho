import { FeaturePage, FeatureCard, FeatureSteps, FeatureCta } from '../components/FeaturePage';
import { Donut, Legend } from '../components/charts';

/* /bond-desk — the Bond Desk EXPLAINER (marketing surface). Deliberately
 * does NOT embed the live desk (that lives at /offer-desk, linked from
 * the CTA): this page is the shareable "what is this thing" story with
 * static visuals only — no wallets, no live claims, nothing to connect. */

const PROCEEDS = [
    { pct: 80, color: 'var(--neon-cyan)', label: 'Buybacks: the desk buys AFHO back off the market' },
    { pct: 10, color: 'var(--neon-pink)', label: 'Dip reserve: fuel for the dip sniper' },
    { pct: 10, color: 'var(--neon-purple)', label: 'Locking rewards: paid to stakers' },
];

export default function BondDesk() {
    return (
        <FeaturePage
            eyebrow="Bond Desk"
            headline="Wall St sleeps. The desk doesn't."
            lede="After the closing bell, AFHO sells its own inventory: discounted, vesting bonds paid for in USDC. Lot sizes, discounts and vesting aren't picked by a team. They're set on-chain from the token's own staking health and price momentum."
            title="Bond Desk | After Hours"
            description="How the after-hours bond desk works: discounted vesting AFHO lots priced off the live token, with a buyback floor under every sheet."
        >
            <div className="feature-grid">
                <FeatureCard title="What a bond is here">
                    <p>
                        You pay USDC; the desk locks a lot of AFHO to you that
                        vests over the lot&rsquo;s schedule. Cheaper than market
                        if you&rsquo;re patient, and that patience is exactly what
                        the protocol pays for.
                    </p>
                </FeatureCard>
                <FeatureCard title="Pricing with a spine">
                    <p>
                        Discounts are taken off the live token price, and a
                        ratcheting buyback floor, the high-water mark of every
                        past buyback, sits under the sheet. The desk never
                        sells below what it paid. No floor, no sale.
                    </p>
                </FeatureCard>
                <FeatureCard title="The late-nite bonus">
                    <p>
                        While the market is fully CLOSED, every remaining lot
                        prices 0.5% deeper. The longer the street sleeps, the
                        better the paper.
                    </p>
                </FeatureCard>
                <FeatureCard title="When trading halts">
                    <p>
                        A circuit-breaker halt swaps the regular sheet for a
                        separate fixed-terms one: set cuts off the live
                        price, no ratchet, no bonus. Chaos gets its own desk.
                    </p>
                </FeatureCard>
            </div>

            <div className="feature-chart-row">
                <div className="feature-chart glass-pane">
                    <h3>Where every sale goes</h3>
                    <Donut
                        segments={PROCEEDS}
                        centerTop="100%"
                        centerBottom="of proceeds"
                        label="Bond offer proceeds: 80% buybacks, 10% dip reserve, 10% locking rewards"
                    />
                    <Legend items={PROCEEDS.map(({ color, label }) => ({ color, label }))} />
                </div>
            </div>

            <FeatureSteps
                caption="A night at the desk"
                steps={[
                    'The bell rings; the sheet posts only when the live discount clears the gate; the desk never sells into a strong price.',
                    'Three lot sizes, each with its own discount and vesting schedule, set from on-chain metrics.',
                    'Buyers pay USDC; the AFHO lot vests to them on schedule.',
                    'Proceeds route out automatically: buybacks, the dip reserve, and locking rewards. Nothing sits in a team wallet.',
                ]}
            />

            <FeatureCta
                href="/offer-desk"
                label="View the live desk"
                note="Live lots, real prices, only while the window is open."
                internal
            />
        </FeaturePage>
    );
}
