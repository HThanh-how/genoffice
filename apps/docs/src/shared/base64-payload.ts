/**
 * The one base64 policy for payloads the renderer sends to the main process.
 *
 * `Buffer.from(text, 'base64')` is forgiving: it ignores characters outside the
 * alphabet, accepts padding in the middle, and silently discards the leftover
 * bits of a non-canonical last group. A length computed from the string's
 * character count therefore disagrees with the bytes actually written — "A"
 * decodes to one byte, "AAAA=" to three, "A===" to one. Every writer's size
 * limit has to describe the buffer it is about to store, so a payload that does
 * not round-trip is refused rather than measured after the fact.
 *
 * The encoded length is checked *before* `Buffer.from`: a gigabyte of base64 is
 * rejected on its character count, so refusing an oversized payload never
 * allocates the gigabyte Buffer it would have produced.
 */
export type Base64Payload = { ok: true; bytes: Buffer } | { ok: false; error: string }

/** exactly the number of characters a `maxBytes` payload can need when encoded */
export function maxEncodedChars(maxBytes: number): number {
  // 32 MiB decoded needs exactly 4 * ceil(32MiB / 3) characters encoded; the
  // ceiling has to be taken on the group count, not on the product, or a payload
  // sitting exactly at the limit is rejected
  return 4 * Math.ceil(maxBytes / 3)
}

export function decodeCanonicalBase64(
  text: unknown,
  maxBytes: number,
  what: string,
): Base64Payload {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: `${what} is empty` }
  }
  if (text.length > maxEncodedChars(maxBytes)) {
    return { ok: false, error: `${what} is larger than it can be` }
  }
  // canonical base64 comes in whole groups of four, with at most two '=' at the end
  if (text.length % 4 !== 0) return { ok: false, error: `${what} is not valid base64` }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return { ok: false, error: `${what} is not valid base64` }
  }
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 0) return { ok: false, error: `${what} is empty` }
  if (decoded.length > maxBytes) {
    return { ok: false, error: `${what} is larger than it can be` }
  }
  // stray padding or a last group with unused bits decodes to something the
  // sender did not mean to send
  if (Buffer.from(decoded).toString('base64') !== text) {
    return { ok: false, error: `${what} is not valid base64` }
  }
  return { ok: true, bytes: decoded }
}
