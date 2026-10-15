#!/usr/bin/env bash
# Rotate ALL program keypairs for a clean-slate devnet relaunch (new program
# IDs = fresh PDA namespaces — the crank's global accounts make in-place
# re-inits impossible). Old keypairs are ARCHIVED, never deleted (program
# close needs them for rent recovery). Usage: tools/rotate-program-keys.sh
#   optionally: PROGRAMS="amm staking" tools/rotate-program-keys.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAMS=${PROGRAMS:-"amm crank_oracle staking"}
ARCHIVE="../archived-keypairs-$(date +%F-%H%M)"
mkdir -p "$ARCHIVE"

echo "━━ archiving old keypairs → $ARCHIVE"
for p in $PROGRAMS; do
    f="target/deploy/$p-keypair.json"
    [ -f "$f" ] || { echo "  !! $f missing, skipping"; continue; }
    old_id=$(solana-keygen pubkey "$f")
    mv "$f" "$ARCHIVE/$p-$old_id.json"
    echo "  $p: $old_id archived"
done

echo "━━ anchor build (regenerates keypairs; declare_id!/Anchor.toml for anchor programs)"
anchor build

echo "━━ syncing the NATIVE crank const (anchor never auto-syncs it)"
CRANK_ID=$(solana-keygen pubkey target/deploy/crank_oracle-keypair.json)
sed -i "s|pub const ID: Pubkey = solana_program::pubkey!(\"[^\"]*\")|pub const ID: Pubkey = solana_program::pubkey!(\"$CRANK_ID\")|" programs/crank-oracle/src/constants.rs
anchor build

echo "━━ new program ids (verify Anchor.toml + declare_id! match before deploying):"
for p in $PROGRAMS; do
    echo "  $p: $(solana-keygen pubkey target/deploy/$p-keypair.json)"
done
grep -A4 '\[programs' Anchor.toml
echo "━━ next: anchor deploy && anchor run launch"
