import { useWallet } from '@solana/wallet-adapter-react';

interface WalletMarkProps {
    size?: number;
}

/* The connected wallet's own mark at button-icon scale — the same icon
   URL the wallet modal and connected button already display (the Adapter
   interface requires `icon: string`), so it swaps with whatever wallet
   the visitor is using. Renders nothing until a wallet is selected, and
   removes itself if the icon URL ever fails to load. */
export function WalletMark({ size = 16 }: WalletMarkProps) {
    const { wallet } = useWallet();
    const icon = wallet?.adapter.icon;
    if (!icon) return null;
    return (
        <img
            className="wallet-mark"
            src={icon}
            alt=""
            aria-hidden="true"
            width={size}
            height={size}
            onError={(e) => e.currentTarget.remove()}
        />
    );
}
