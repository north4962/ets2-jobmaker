/**
 * AES (FIPS-197) の復号のみを実装した最小構成。CBC モード、パディング除去なし。
 * ScsC 形式のパディングは PKCS#7 とは限らないため、WebCrypto ではなく自前で実装している。
 */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
// 逆 MixColumns 用の乗算テーブル
const MUL9 = new Uint8Array(256);
const MUL11 = new Uint8Array(256);
const MUL13 = new Uint8Array(256);
const MUL14 = new Uint8Array(256);

function xtime(a: number) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}
function mul(a: number, b: number) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

(function initTables() {
  // GF(2^8) の逆元から S-box を生成
  let p = 1;
  let q = 1;
  do {
    p = p ^ xtime(p); // p *= 3
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09; // q /= 3
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    INV_SBOX[SBOX[i]] = i;
    MUL9[i] = mul(i, 9);
    MUL11[i] = mul(i, 11);
    MUL13[i] = mul(i, 13);
    MUL14[i] = mul(i, 14);
  }
})();

function expandKey(key: Uint8Array): Uint8Array {
  const nk = key.length / 4;
  if (![4, 6, 8].includes(nk)) throw new Error('AES の鍵長が不正です');
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t0 = w[(i - 1) * 4];
    let t1 = w[(i - 1) * 4 + 1];
    let t2 = w[(i - 1) * 4 + 2];
    let t3 = w[(i - 1) * 4 + 3];
    if (i % nk === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t0 = SBOX[t0];
      t1 = SBOX[t1];
      t2 = SBOX[t2];
      t3 = SBOX[t3];
    }
    w[i * 4] = w[(i - nk) * 4] ^ t0;
    w[i * 4 + 1] = w[(i - nk) * 4 + 1] ^ t1;
    w[i * 4 + 2] = w[(i - nk) * 4 + 2] ^ t2;
    w[i * 4 + 3] = w[(i - nk) * 4 + 3] ^ t3;
  }
  return w;
}

const t = new Uint8Array(16);
function decryptBlock(s: Uint8Array, w: Uint8Array, nr: number) {
  for (let i = 0; i < 16; i++) s[i] ^= w[nr * 16 + i];
  for (let round = nr - 1; round >= 0; round--) {
    // InvShiftRows + InvSubBytes
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[c * 4 + r] = INV_SBOX[s[((c - r + 4) % 4) * 4 + r]];
    }
    // AddRoundKey
    for (let i = 0; i < 16; i++) t[i] ^= w[round * 16 + i];
    if (round === 0) {
      s.set(t);
      break;
    }
    // InvMixColumns
    for (let c = 0; c < 4; c++) {
      const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
      s[c * 4] = MUL14[a0] ^ MUL11[a1] ^ MUL13[a2] ^ MUL9[a3];
      s[c * 4 + 1] = MUL9[a0] ^ MUL14[a1] ^ MUL11[a2] ^ MUL13[a3];
      s[c * 4 + 2] = MUL13[a0] ^ MUL9[a1] ^ MUL14[a2] ^ MUL11[a3];
      s[c * 4 + 3] = MUL11[a0] ^ MUL13[a1] ^ MUL9[a2] ^ MUL14[a3];
    }
  }
}

/** AES-CBC 復号 (パディングは除去しない)。data の長さは 16 の倍数であること */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16 !== 0) throw new Error('暗号データの長さが 16 の倍数ではありません');
  const w = expandKey(key);
  const nr = key.length / 4 + 6;
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = iv.slice(0, 16);
  const block = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    block.set(data.subarray(off, off + 16));
    decryptBlock(block, w, nr);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prev[i];
    prev = data.subarray(off, off + 16);
  }
  return out;
}
