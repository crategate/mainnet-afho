#!/usr/bin/env bash
# web-dist.sh — the launch chain's web step (`anchor run web-dist`; runs as
# the LAST step of `anchor run launch`). Two jobs, in order:
#   1. `npm run build` in app/ (tsc -b && vite build) — the TYPECHECK gate.
#      vite dev/HMR never typechecks, so hand-mirrored account types (e.g.
#      Position vs the staking IDL) can drift green-in-dev yet fail the
#      build; this is where that surfaces, before anything is uploaded.
#   2. Zip dist for upload: app/dist/dep.zip holding the CONTENTS of dist —
#      the old manual `cd app/dist && zip -r dep.zip .`.
# app/public/ is copied into dist/ at build time, so this must run AFTER the
# launch steps that write deployment.json (amm-init, set-pools) — the zip
# carries the deployment the chain just created.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"

echo "━━━ web-dist: npm run build in app/ (tsc -b && vite build) ━━━"
(cd "$root/app" && npm run build)

cd "$root/app/dist"
# Fresh archive every time: `zip -r` onto an existing dep.zip MERGES, so
# files deleted from a later build would survive into the upload forever.
# Excluded: the review flow's *.rejected bench files, .gitkeep placeholders,
# and the state-images README (dev-side docs, not site content).
rm -f dep.zip
echo "━━━ web-dist: zipping app/dist → dep.zip ━━━"
zip -r dep.zip . -x '*.rejected' -x '*.gitkeep' -x 'state-images/README.md' >/dev/null

# Post-hoc verify — never ship a broken bundle: the deployment the chain
# wrote and the entry point must both be inside the archive. (Grep the
# captured listing, NOT `unzip -l | grep -q`: -q exits on first match, unzip
# takes a SIGPIPE, and pipefail turns that into a false "missing".)
listing="$(unzip -l dep.zip)"
for f in deployment.json index.html; do
    if ! grep -Eq "[[:space:]]${f}\$" <<<"$listing"; then
        echo "✗ web-dist: ${f} is missing from dep.zip — DO NOT upload this zip." >&2
        exit 1
    fi
done
if grep -Eq '\.rejected|\.gitkeep|state-images/README\.md' <<<"$listing"; then
    echo "✗ web-dist: dev-side files (rejected/gitkeep/README) leaked into dep.zip — DO NOT upload." >&2
    exit 1
fi

echo "✓ web-dist: app/dist/dep.zip ready for upload"
unzip -l dep.zip | tail -n 2
ls -l dep.zip
