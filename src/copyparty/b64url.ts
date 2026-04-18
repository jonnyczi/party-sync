export const CHUNK_HASH_BYTES = 33;

const B64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url encode (no padding). Mirrors `buf2b64` in copyparty's
 * `web/up2k.js` so chunk hashes are bit-identical to the web client.
 */
export function bufToB64Url(src: Uint8Array): string {
  let out = '';
  const nbytes = src.byteLength;
  const byteRem = nbytes % 3;
  const mainLen = nbytes - byteRem;
  for (let i = 0; i < mainLen; i += 3) {
    const chunk = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    out += B64URL_ALPHABET[(chunk & 0xfc0000) >> 18];
    out += B64URL_ALPHABET[(chunk & 0x03f000) >> 12];
    out += B64URL_ALPHABET[(chunk & 0x000fc0) >> 6];
    out += B64URL_ALPHABET[chunk & 0x3f];
  }
  if (byteRem === 1) {
    const chunk = src[mainLen];
    out += B64URL_ALPHABET[(chunk & 0xfc) >> 2];
    out += B64URL_ALPHABET[(chunk & 0x03) << 4];
  } else if (byteRem === 2) {
    const chunk = (src[mainLen] << 8) | src[mainLen + 1];
    out += B64URL_ALPHABET[(chunk & 0xfc00) >> 10];
    out += B64URL_ALPHABET[(chunk & 0x03f0) >> 4];
    out += B64URL_ALPHABET[(chunk & 0x0f) << 2];
  }
  return out;
}
