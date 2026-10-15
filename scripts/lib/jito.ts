// jito.ts — Jito block-engine bundle helpers for the atomic launch
// (launch-bundle.ts). Lifted from the retired buyer's src/jito.ts so the
// token repo is self-contained. Only the functions the launch needs:
// tip accounts, sendBundle, getBundleStatuses (polled from the block engine,
// not the RPC — no credits, no rate limit).

const TIP_ACCOUNTS_FALLBACK = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6EAvHh1gLVPrjDYvdZDhvvz",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

const DEFAULT_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

type SerializableTx = { serialize(): Uint8Array };

export function blockEngineUrl(): string {
  return process.env.JITO_BLOCK_ENGINE || DEFAULT_BLOCK_ENGINE;
}

/** Fetch the current Jito tip accounts from the block engine. */
export async function getTipAccounts(url = blockEngineUrl()): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
  });
  const json = (await res.json()) as { error?: { message: string }; result?: string[] };
  if (json.error) throw new Error(`getTipAccounts: ${json.error.message}`);
  return json.result && json.result.length ? json.result : TIP_ACCOUNTS_FALLBACK;
}

// Local base58 (Bitcoin alphabet) encoder — the bundle API takes bs58 strings;
// keeping it local avoids depending on where pnpm exposes the transitive bs58.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += B58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/** Decode a base58 (Bitcoin alphabet) string to bytes. */
export function bs58Decode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of str) {
    const value = B58_ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`invalid base58 character '${ch}'`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch !== B58_ALPHABET[0]) break;
    bytes.push(0); // leading '1's are leading zero bytes
  }
  return new Uint8Array(bytes.reverse());
}

/** Submit a bundle (already-signed txs, legacy or versioned, may be mixed) to
 *  the Jito block engine. Returns the bundle uuid. */
export async function sendBundle(signedTxs: SerializableTx[], url = blockEngineUrl()): Promise<string> {
  const bundle = signedTxs.map((tx) => bs58Encode(tx.serialize()));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [{ bundle, uuid: Math.random().toString(36).slice(2) + Date.now().toString(36) }],
    }),
  });
  const json = (await res.json()) as { error?: { message: string }; result?: string };
  if (json.error) throw new Error(`sendBundle: ${json.error.message}`);
  return json.result ?? "";
}

export interface BundleStatus {
  confirmationStatus: string | null; // processed | confirmed | finalized | null (pending/unknown)
  err: string | null;
  landed: boolean;
}

/** Poll bundle landing state from the block engine. */
export async function getBundleStatuses(uuids: string[], url = blockEngineUrl()): Promise<Map<string, BundleStatus>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBundleStatuses", params: [[...uuids]] }),
  });
  const json = (await res.json()) as {
    error?: { message: string };
    result?: { value?: Array<{ confirmation_status?: string; err?: unknown } | null> };
  };
  if (json.error) throw new Error(`getBundleStatuses: ${json.error.message}`);
  const out = new Map<string, BundleStatus>();
  (json.result?.value ?? []).forEach((v, i) => {
    const confirmationStatus = v?.confirmation_status ?? null;
    out.set(uuids[i], {
      confirmationStatus,
      err: v?.err ? JSON.stringify(v.err) : null,
      landed: confirmationStatus === "confirmed" || confirmationStatus === "finalized",
    });
  });
  return out;
}
