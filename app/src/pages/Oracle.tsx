import { FeaturePage, FeatureSteps, FeatureCta } from '../components/FeaturePage';
import { MarketStatus } from '../components/MarketStatus';
import { useChainData } from '../context/useChainData';

/* /oracle — the Oracle Feed page. The shareable canonical link for "how
 * does the token know what time it is": live MarketStatus tile (the same
 * account every program reads), the crank pipeline in four steps, and the
 * states table mapping session -> mechanics. */

const STATES_TABLE: [string, string, string][] = [
    [
        'Market Open',
        'Regular NYSE session',
        'Reward claims run. No penalties to exit. The desk rests.',
    ],
    [
        'After Hours',
        'Pre-market & post-close',
        'Reward claims pause. Small penalty to exit. The bond desk can open at a discount.',
    ],
    [
        'Market Closed',
        'Overnight & weekends',
        'Medium penalty to exit. The desk can still sell at a deeper discount.',
    ],
    [
        'Trading Halted',
        'Circuit breaker tripped',
        'Severe penalties to close positions.',
    ],
];

export default function Oracle() {
    const { deployment } = useChainData();

    return (
        <FeaturePage
            eyebrow="Oracle Feed"
            headline="The market clock lives on-chain."
            lede="No admin flips switches. The NYSE session schedule lives on-chain as data, the clock is Solana's own, and every AFHO mechanic (rewards, penalties, the bond desk) keys off the account they produce."
            title="Oracle Feed | After Hours"
            description="How AFHO tracks NYSE market hours on-chain from a published calendar and Solana's own clock, and why nobody can fudge either."
        >
            <div
                className="feature-live market-tile-frame neon-glitch neon-shadow shadow-wander-b"
                style={{ '--glitch-delay': '1.2s', '--shadow-delay': '0.5s' } as React.CSSProperties}
            >
                <MarketStatus marketStatusPda={deployment?.marketStatusKey} variant="full" />
            </div>

            <FeatureSteps
                caption="How an update happens"
                steps={[
                    'A keeper bot, or anyone (it\u2019s permissionless), cranks the oracle program.',
                    'The program derives the session state itself: the on-chain calendar (published NYSE hours, holidays, half days) evaluated against Solana\u2019s clock. No oracle signs anything.',
                    'The MarketStatus account updates: session state, trading day, and the exact bell timestamp.',
                    'Every program in the protocol reads that same account. Nothing else moves.',
                ]}
            />

            <div className="feature-table-wrap">
                <table className="feature-table">
                    <thead>
                        <tr>
                            <th>State</th>
                            <th>Session</th>
                            <th>What changes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {STATES_TABLE.map(([state, session, effect]) => (
                            <tr key={state}>
                                <td>{state}</td>
                                <td>{session}</td>
                                <td>{effect}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* The breaker's price reference, credited where the Trading
                Halted row above raises it. */}
            <div className="oracle-source glass-pane">
                <img src="/spyx-logo.png" alt="SPYx logo" loading="lazy" />
                <p>
                    The circuit breaker&rsquo;s price reference is{' '}
                    <a
                        href="https://www.backed.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        SPYx
                    </a>
                    , tokenized S&amp;P 500 exposure issued by Backed (xStocks).
                    At launch the halt layer reads SPYx&rsquo;s on-chain pools
                    directly: no website, no off-chain feed, nobody&rsquo;s
                    promise.
                </p>
            </div>

            <FeatureSteps
                caption="Why you can trust the clock"
                steps={[
                    'The schedule is DATA in its own on-chain account; the program has no hours hardcoded and no admin can state a session by hand.',
                    'Calendar updates are queued as pending and only take effect at the next bell, so mid-session surprises are impossible.',
                    'State is derived from Solana\u2019s own clock: there is no signer, no feed, and no website to trust or take down.',
                    'Everything above is a Solscan away: the calendar and MarketStatus accounts are public state.',
                ]}
            />

            <FeatureCta
                href="/locking"
                label="Next: Locking Rewards"
                note="See what the clock does for stakers."
                internal
            />
        </FeaturePage>
    );
}
