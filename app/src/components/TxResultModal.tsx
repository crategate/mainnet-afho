import { CopyAddress } from './CopyAddress';
import { SolscanMark, SolanaMark } from './BrandIcons';
import { useDeployment } from '../hooks/useDeployment';

/* One transaction result, as reported by whichever flow signed it. */
export type TxReport = {
    kind: 'success' | 'error';
    /* Human result line, e.g. "Position frozen for 21 trading days". */
    headline: string;
    /* Signature when a transaction made it onto the wire (even a failed
       landing has one worth inspecting). */
    signature?: string;
    /* Raw detail: the thrown error message on failures. */
    detail?: string;
};

interface TxResultModalProps {
    report: TxReport;
    onClose: () => void;
}

/* Devnet (and friends) need the cluster param; mainnet links go bare. */
function clusterSuffix(cluster?: string) {
    return cluster && cluster !== 'mainnet' && cluster !== 'mainnet-beta'
        ? `?cluster=${cluster}`
        : '';
}

/* Explorer links for a transaction signature (branded buttons elsewhere
   in the app consume these). */
export function explorerUrls(signature: string, cluster?: string) {
    const suffix = clusterSuffix(cluster);
    return {
        solscan: `https://solscan.io/tx/${signature}${suffix}`,
        solana: `https://explorer.solana.com/tx/${signature}${suffix}`,
    };
}

/* Explorer links for an account (Records row links, etc.). */
export function accountUrls(address: string, cluster?: string) {
    const suffix = clusterSuffix(cluster);
    return {
        solscan: `https://solscan.io/account/${address}${suffix}`,
        solana: `https://explorer.solana.com/address/${address}${suffix}`,
    };
}

/* Branded replacement for the old alert()-on-every-transaction flow.
   Success carries the signature plus explorer buttons wearing each
   explorer's own mark; failure goes loud: red pane, big header, the raw
   error, and the refresh-first instruction. */
export function TxResultModal({ report, onClose }: TxResultModalProps) {
    const { deployment } = useDeployment();
    const failed = report.kind === 'error';
    const urls = report.signature
        ? explorerUrls(report.signature, deployment?.cluster)
        : null;
    const shortSig = report.signature
        ? `${report.signature.slice(0, 10)}…${report.signature.slice(-10)}`
        : null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className={`tx-modal glass-pane neon-glitch${failed ? ' tx-modal--error' : ''}`}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="tx-modal-title"
                onClick={(e) => e.stopPropagation()}
            >
                {failed ? (
                    <h3 className="tx-fail-title" id="tx-modal-title">
                        Transaction Failed
                    </h3>
                ) : (
                    <p className="tx-kicker" id="tx-modal-title">
                        Transaction confirmed
                    </p>
                )}
                <p className="tx-headline">{report.headline}</p>
                {report.detail && (
                    <pre className="tx-detail">{report.detail}</pre>
                )}
                {failed && (
                    <p className="tx-advice">
                        Refresh the page before retrying. A stale session is
                        behind most repeat failures; a clean reload resyncs
                        your balances and positions. Check that nothing landed
                        before you sign again.
                    </p>
                )}
                {shortSig && (
                    <div className="tx-sig">
                        <span className="tx-sig-label">Signature</span>
                        <CopyAddress
                            value={report.signature as string}
                            display={shortSig}
                            className="tx-sig-copy"
                            title="Copy transaction signature"
                        />
                    </div>
                )}
                {urls && (
                    <div className="tx-explorers">
                        <a
                            className="tx-explorer-button tx-explorer-button--solscan"
                            href={urls.solscan}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <SolscanMark />
                            <span>View on Solscan</span>
                        </a>
                        <a
                            className="tx-explorer-button tx-explorer-button--solana"
                            href={urls.solana}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <SolanaMark />
                            <span>Solana Explorer</span>
                        </a>
                    </div>
                )}
                <div className="tx-actions">
                    <button type="button" className="tx-dismiss" onClick={onClose}>
                        {failed ? 'Dismiss' : 'Done'}
                    </button>
                    {failed && (
                        <button
                            type="button"
                            className="tx-refresh"
                            onClick={() => window.location.reload()}
                        >
                            Refresh page
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
