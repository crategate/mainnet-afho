import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

const COPIED_MS = 1800;

function CopyIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <g
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </g>
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20 6 9 17l-5-5"
            />
        </svg>
    );
}

/* Prefer the async clipboard API (secure contexts); fall back to a hidden
   textarea + execCommand for older/insecure embeds so copy still works on a
   plain devnet build over http. */
async function writeClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            /* fall through to the legacy path */
        }
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

interface CopyAddressProps {
    /** Full value copied to the clipboard. */
    value: string;
    /** Optional rendered label; defaults to the full value. */
    display?: ReactNode;
    className?: string;
    title?: string;
}

export function CopyAddress({ value, display, className = '', title }: CopyAddressProps) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, []);

    const handleCopy = useCallback(async () => {
        const ok = await writeClipboard(value);
        if (!ok) return;
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    }, [value]);

    return (
        <button
            type="button"
            className={`copy-address${className ? ` ${className}` : ''}${copied ? ' copied' : ''}`}
            onClick={handleCopy}
            title={title ?? `Copy ${value}`}
            aria-label={`Copy address ${value}`}
        >
            <span className="copy-address-value">{display ?? value}</span>
            <span className="copy-address-icon" aria-hidden="true">
                {copied ? <CheckIcon /> : <CopyIcon />}
            </span>
        </button>
    );
}
