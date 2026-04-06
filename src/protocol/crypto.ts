/**
 * Group Content Key (GCK) crypto utilities.
 *
 * AES-256-GCM encryption with AAD binding per the Group Messaging Protocol 1.0 spec:
 *   AAD = UTF-8(group_id || "." || epoch || "." || sender)
 *
 * All binary↔string conversions use base64url (RFC 4648 §5) as required by the spec.
 */

// ---------------------------------------------------------------------------
// Base64url helpers (RFC 4648 §5 — no padding)
// ---------------------------------------------------------------------------

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const B64URL_MAP: Record<string, number> = {}
for (let i = 0; i < B64_CHARS.length; i++) B64URL_MAP[B64_CHARS[i]] = i
B64URL_MAP["-"] = 62
B64URL_MAP["_"] = 63

export function toBase64Url(bytes: Uint8Array): string {
  let result = ""
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i]
    const b = i + 1 < len ? bytes[i + 1] : 0
    const c = i + 2 < len ? bytes[i + 2] : 0
    result += B64_CHARS[(a >> 2) & 0x3f]
    result += B64_CHARS[((a << 4) | (b >> 4)) & 0x3f]
    if (i + 1 < len) result += B64_CHARS[((b << 2) | (c >> 6)) & 0x3f]
    if (i + 2 < len) result += B64_CHARS[c & 0x3f]
  }
  // Convert to base64url (no padding)
  return result.replace(/\+/g, "-").replace(/\//g, "_")
}

export function fromBase64Url(b64url: string): Uint8Array {
  const str = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const len = str.length
  const outLen = (len * 3) >> 2
  const out = new Uint8Array(outLen)
  let j = 0
  for (let i = 0; i < len; i += 4) {
    const a = B64URL_MAP[str[i]] ?? 0
    const b = B64URL_MAP[str[i + 1]] ?? 0
    const c = i + 2 < len ? (B64URL_MAP[str[i + 2]] ?? 0) : 0
    const d = i + 3 < len ? (B64URL_MAP[str[i + 3]] ?? 0) : 0
    out[j++] = (a << 2) | (b >> 4)
    if (j < outLen) out[j++] = ((b << 4) | (c >> 2)) & 0xff
    if (j < outLen) out[j++] = ((c << 6) | d) & 0xff
  }
  return out
}

// ---------------------------------------------------------------------------
// GCK generation / import / export
// ---------------------------------------------------------------------------

/** Generate a fresh AES-256-GCM key for group content encryption */
export async function generateGCK(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  )
}

/** Export a CryptoKey to base64url string for transport */
export async function exportGCK(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key)
  return toBase64Url(new Uint8Array(raw))
}

/** Import a base64url string back to CryptoKey */
export async function importGCK(base64url: string): Promise<CryptoKey> {
  const raw = fromBase64Url(base64url)
  return await crypto.subtle.importKey(
    "raw",
    raw.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  )
}

// ---------------------------------------------------------------------------
// GCK encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext with GCK using AES-256-GCM.
 *
 * AAD = UTF-8(group_id + "." + epoch + "." + sender)
 *
 * Returns separate ciphertext, iv, and tag fields (spec requires tag as distinct field).
 * WebCrypto appends the 16-byte GCM tag to ciphertext — we split them.
 */
export async function encryptWithGCK(
  key: CryptoKey,
  plaintext: string,
  groupId: string,
  epoch: number,
  senderDid: string
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode(`${groupId}.${epoch}.${senderDid}`)
  const encoded = new TextEncoder().encode(plaintext)

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    key,
    encoded
  )

  const fullBytes = new Uint8Array(encrypted)
  // AES-GCM output = ciphertext || tag (last 16 bytes)
  const ctBytes = fullBytes.slice(0, fullBytes.length - 16)
  const tagBytes = fullBytes.slice(fullBytes.length - 16)

  return {
    ciphertext: toBase64Url(ctBytes),
    iv: toBase64Url(iv),
    tag: toBase64Url(tagBytes),
  }
}

/**
 * Decrypt ciphertext with GCK using AES-256-GCM.
 *
 * Reassembles ciphertext + tag before decryption (WebCrypto expects them concatenated).
 */
export async function decryptWithGCK(
  key: CryptoKey,
  ciphertext: string,
  iv: string,
  tag: string,
  groupId: string,
  epoch: number,
  senderDid: string
): Promise<string> {
  const aad = new TextEncoder().encode(`${groupId}.${epoch}.${senderDid}`)
  const ctBytes = fromBase64Url(ciphertext)
  const tagBytes = fromBase64Url(tag)
  const ivBytes = fromBase64Url(iv)

  // Reassemble: ciphertext || tag
  const combined = new Uint8Array(ctBytes.length + tagBytes.length)
  combined.set(ctBytes)
  combined.set(tagBytes, ctBytes.length)

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.buffer as ArrayBuffer, additionalData: aad.buffer as ArrayBuffer, tagLength: 128 },
    key,
    combined.buffer as ArrayBuffer
  )

  return new TextDecoder().decode(decrypted)
}

// ---------------------------------------------------------------------------
// Epoch hash chain
// ---------------------------------------------------------------------------

/** Helper: SHA-256 of arbitrary bytes, returned as Uint8Array */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer)
  return new Uint8Array(hash)
}

/** Convert bytes to lowercase hex string */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Compute the GCK fingerprint: SHA-256 of the raw key bytes.
 */
export async function gckFingerprint(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key))
  const hash = await sha256(raw)
  return toHex(hash)
}

/**
 * Compute epoch hash per spec:
 *
 *   epoch_hash = SHA-256(
 *     previous_epoch_hash ||
 *     epoch_number ||
 *     sorted_member_dids ||
 *     gck_fingerprint
 *   )
 *
 * - previous_epoch_hash: empty string for epoch 0
 * - epoch_number: ASCII decimal
 * - sorted_member_dids: lexicographically sorted, joined with "|"
 * - gck_fingerprint: SHA-256(raw_gck_bytes) as hex
 *
 * Returns: "sha256:<hex>"
 */
export async function computeEpochHash(
  prevHash: string,
  epoch: number,
  memberDids: string[],
  gckFp: string
): Promise<string> {
  const sorted = [...memberDids].sort().join("|")
  const input = `${prevHash}${epoch}${sorted}${gckFp}`
  const hash = await sha256(new TextEncoder().encode(input))
  return `sha256:${toHex(hash)}`
}
