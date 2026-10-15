import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletMark } from './WalletMark';

/* WalletMultiButton with one AFHO addition: an "Activity" row in the
   connected dropdown linking to /activity. The stock component offers no
   slot to inject an item, so this mirrors its markup and class names —
   the globally imported wallet-adapter-react-ui stylesheet styles it
   identically. Behavior matches the stock button state for state
   (no wallet → modal, unconnected → connect, connected → dropdown). */
export function AfhoWalletButton() {
    const { wallet, publicKey, connecting, disconnect } = useWallet();
    const { setVisible } = useWalletModal();
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    /* Outside press closes the menu (same listener pair the stock button
       uses); Escape closes too. */
    useEffect(() => {
        if (!open) return;
        const close = (event: Event) => {
            if (event.type === 'keydown') {
                if ((event as KeyboardEvent).key === 'Escape') setOpen(false);
                return;
            }
            if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('touchstart', close);
        document.addEventListener('keydown', close);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('touchstart', close);
            document.removeEventListener('keydown', close);
        };
    }, [open]);

    const base58 = publicKey?.toBase58();
    let content = 'Select Wallet';
    if (base58) {
        content = `${base58.slice(0, 4)}..${base58.slice(-4)}`;
    } else if (connecting) {
        content = 'Connecting…';
    } else if (wallet) {
        content = 'Connect';
    }

    const onTriggerClick = () => {
        if (base58) {
            setOpen((v) => !v);
        } else if (!wallet) {
            setVisible(true);
        } else {
            void wallet.adapter.connect();
        }
    };

    const copyAddress = async () => {
        if (!base58) return;
        await navigator.clipboard.writeText(base58);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 400);
    };

    return (
        <div className="wallet-adapter-dropdown afho-wallet-dropdown" ref={wrapRef}>
            <button
                type="button"
                className="wallet-adapter-button wallet-adapter-button-trigger"
                aria-expanded={open}
                aria-haspopup="menu"
                onClick={onTriggerClick}
            >
                {/* WalletMark, not react-ui's WalletIcon: WalletIcon renders
                    a bare unclassed <img> that blows up to the icon's
                    intrinsic size and overflows the button. */}
                {wallet && <WalletMark size={16} />}
                {content}
            </button>
            <ul
                aria-label="dropdown-list"
                role="menu"
                className={`wallet-adapter-dropdown-list${open ? ' wallet-adapter-dropdown-list-active' : ''}`}
            >
                {base58 && (
                    <li
                        className="wallet-adapter-dropdown-list-item"
                        role="menuitem"
                        onClick={() => void copyAddress()}
                    >
                        {copied ? 'Copied' : 'Copy address'}
                    </li>
                )}
                <li className="wallet-adapter-dropdown-list-item afho-wallet-activity-item" role="none">
                    <Link to="/activity" role="menuitem" onClick={() => setOpen(false)}>
                        Activity
                    </Link>
                </li>
                <li
                    className="wallet-adapter-dropdown-list-item"
                    role="menuitem"
                    onClick={() => {
                        setVisible(true);
                        setOpen(false);
                    }}
                >
                    Change wallet
                </li>
                <li
                    className="wallet-adapter-dropdown-list-item"
                    role="menuitem"
                    onClick={() => {
                        void disconnect?.();
                        setOpen(false);
                    }}
                >
                    Disconnect
                </li>
            </ul>
        </div>
    );
}
