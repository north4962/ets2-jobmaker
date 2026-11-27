/**
 * テスト専用: テキスト SII → BSII → ScsC のエンコーダ。
 * 本物の暗号化セーブが無くても、復号・デコードがテキストを完全に復元できるかを検証するために使う。
 * 値の型はテキストの見た目から推定する (実ゲームの型定義とは一致しないが、出力が同一になる型を選ぶ)。
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { zlibSync } from 'fflate';
import { parseSii } from '../../src/core/sii';
import { SII_KEY } from '../../src/core/decrypt';

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyz_';
const isToken = (s: string) => s.length > 0 && s.length <= 12 && [...s].every((c) => TOKEN.includes(c));

export function encodeToken(s: string): bigint {
  let v = 0n;
  for (let i = s.length - 1; i >= 0; i--) v = v * 38n + BigInt(TOKEN.indexOf(s[i]) + 1);
  return v;
}

class Writer {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      this.chunks.push(this.buf.slice(0, this.pos));
      this.buf = new Uint8Array(Math.max(1 << 16, n));
      this.view = new DataView(this.buf.buffer);
      this.pos = 0;
    }
  }
  u8(v: number) { this.ensure(1); this.buf[this.pos++] = v; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  u64(v: bigint) { this.ensure(8); this.view.setBigUint64(this.pos, v, true); this.pos += 8; }
  i64(v: bigint) { this.ensure(8); this.view.setBigInt64(this.pos, v, true); this.pos += 8; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  str(s: string | Uint8Array) {
    const b = typeof s === 'string' ? Uint8Array.from(s, (c) => c.charCodeAt(0)) : s;
    this.u32(b.length);
    this.bytes(b);
  }
  result() {
    this.chunks.push(this.buf.slice(0, this.pos));
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

type Enc = { type: number; write: (w: Writer) => void };

const f32 = new DataView(new ArrayBuffer(4));
function floatBits(s: string): number | null {
  if (/^&[0-9a-f]{8}$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Math.abs(n) >= 1e7) return null;
    f32.setFloat32(0, n);
    return f32.getUint32(0);
  }
  return null;
}

function writeId(w: Writer, s: string) {
  if (s === 'null') return w.u8(0);
  if (s.startsWith('_nameless.')) {
    w.u8(0xff);
    let v = 0n;
    for (const p of s.slice(10).split('.')) v = (v << 16n) | BigInt('0x' + p);
    return w.u64(v);
  }
  const parts = s.split('.');
  w.u8(parts.length);
  for (const p of parts) w.u64(encodeToken(p));
}

function unescapeBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === 'x') {
      out.push(parseInt(s.slice(i + 2, i + 4), 16));
      i += 3;
    } else out.push(s.charCodeAt(i));
  }
  return Uint8Array.from(out);
}

/** 値文字列から (スカラー) 型を推定 */
function scalar(v: string): Enc | null {
  if (v === 'true' || v === 'false') return { type: 0x35, write: (w) => w.u8(v === 'true' ? 1 : 0) };
  if (v === 'nil') return { type: 0x27, write: (w) => w.u32(0xffffffff) };
  if (v === 'null' || /^_nameless(\.[0-9a-f]{1,4})+$/.test(v)) return { type: 0x39, write: (w) => writeId(w, v) };
  if (/^-?\d+$/.test(v)) {
    const n = BigInt(v);
    if (n >= -(2n ** 31n) && n < 2n ** 31n) return { type: 0x25, write: (w) => w.i32(Number(n)) };
    if (n >= 0n && n >= 2n ** 63n) return { type: 0x33, write: (w) => w.u64(n) };
    return { type: 0x31, write: (w) => w.i64(n) };
  }
  if (/^&[0-9a-f]{8}$/.test(v)) return { type: 0x05, write: (w) => w.u32(floatBits(v)!) };
  let m = /^\(([^;(),]+), ([^;(),]+)\)$/.exec(v);
  if (m) {
    const b = [m[1], m[2]].map(floatBits);
    if (b.every((x) => x !== null)) return { type: 0x07, write: (w) => b.forEach((x) => w.u32(x!)) };
    return null;
  }
  m = /^\(([^;(),]+), ([^;(),]+), ([^;(),]+)\)$/.exec(v);
  if (m) {
    const parts = [m[1], m[2], m[3]];
    const b = parts.map(floatBits);
    if (b.every((x) => x !== null)) return { type: 0x09, write: (w) => b.forEach((x) => w.u32(x!)) };
    if (parts.every((p) => /^-?\d+$/.test(p))) return { type: 0x11, write: (w) => parts.forEach((p) => w.i32(Number(p))) };
    return null;
  }
  m = /^\(([^;(),]+); ([^;(),]+), ([^;(),]+), ([^;(),]+)\)$/.exec(v);
  if (m) {
    const b = [m[1], m[2], m[3], m[4]].map(floatBits);
    if (b.every((x) => x !== null)) return { type: 0x17, write: (w) => b.forEach((x) => w.u32(x!)) };
    return null;
  }
  m = /^\(([^;(),]+), ([^;(),]+), ([^;(),]+)\) \(([^;(),]+); ([^;(),]+), ([^;(),]+), ([^;(),]+)\)$/.exec(v);
  if (m) {
    const b = m.slice(1).map(floatBits);
    if (!b.every((x) => x !== null)) return null;
    // バージョン 2: 4 番目の要素に座標の上位ビット係数 (ここではオフセット 0 = 2048, 2048)
    f32.setFloat32(0, 2048 + (2048 << 12));
    const coef = f32.getUint32(0);
    return { type: 0x19, write: (w) => { w.u32(b[0]!); w.u32(b[1]!); w.u32(b[2]!); w.u32(coef); for (let i = 3; i < 7; i++) w.u32(b[i]!); } };
  }
  if (v === '""') return { type: 0x01, write: (w) => w.str('') };
  if (v.startsWith('"') && v.endsWith('"')) {
    const b = unescapeBytes(v.slice(1, -1));
    return { type: 0x01, write: (w) => w.str(b) };
  }
  if (v.includes('.') && v.split('.').every(isToken)) return { type: 0x39, write: (w) => writeId(w, v) };
  if (isToken(v)) return { type: 0x03, write: (w) => w.u64(encodeToken(v)) };
  if (/^[0-9A-Za-z_]+$/.test(v)) return { type: 0x01, write: (w) => w.str(v) };
  return null;
}

const ARRAY_OF: Record<number, number> = {
  0x01: 0x02, 0x03: 0x04, 0x05: 0x06, 0x07: 0x08, 0x09: 0x0a, 0x11: 0x12, 0x17: 0x18, 0x19: 0x1a,
  0x25: 0x26, 0x27: 0x28, 0x31: 0x32, 0x33: 0x34, 0x35: 0x36, 0x39: 0x3a,
};

/** 配列要素群に共通の型を決める */
function arrayEnc(values: string[]): { type: number; items: Enc[] } | null {
  const items = values.map(scalar);
  if (items.some((i) => !i)) return null;
  const types = new Set(items.map((i) => i!.type));
  if (types.size === 1) return { type: ARRAY_OF[items[0]!.type], items: items as Enc[] };
  const only = (...t: number[]) => [...types].every((x) => t.includes(x));
  // "" と トークンの混在 → トークン配列 ("" は 0)
  if (only(0x01, 0x03) && values.every((v) => v === '""' || isToken(v))) {
    return { type: 0x04, items: values.map((v) => ({ type: 0x03, write: (w) => w.u64(v === '""' ? 0n : encodeToken(v)) })) };
  }
  if (values.every((v) => (v.startsWith('"') && v.endsWith('"')) || /^[0-9A-Za-z_]+$/.test(v))) {
    return { type: 0x02, items: values.map((v) => ({ type: 0x01, write: (w) => w.str(v.startsWith('"') ? unescapeBytes(v.slice(1, -1)) : v) })) };
  }
  if (only(0x25, 0x27, 0x31) && values.every((v) => v === 'nil' || (Number(v) >= 0 && Number(v) < 0xffffffff))) {
    return { type: 0x28, items: values.map((v) => ({ type: 0x27, write: (w) => w.u32(v === 'nil' ? 0xffffffff : Number(v)) })) };
  }
  if (only(0x25, 0x31)) return { type: 0x32, items: values.map((v) => ({ type: 0x31, write: (w) => w.i64(BigInt(v)) })) };
  if (only(0x05, 0x25) && values.every((v) => floatBits(v) !== null)) {
    return { type: 0x06, items: values.map((v) => ({ type: 0x05, write: (w) => w.u32(floatBits(v)!) })) };
  }
  if (only(0x09, 0x11) && values.every((v) => /^\(-?\d+, -?\d+, -?\d+\)$/.test(v))) {
    return { type: 0x12, items: values.map((v) => { const p = v.slice(1, -1).split(', ').map(Number); return { type: 0x11, write: (w) => p.forEach((x) => w.i32(x)) }; }) };
  }
  return null;
}

/** テキスト SII を BSII (version 2) に変換。変換できない値があれば例外 */
export function encodeBsii(text: string): Uint8Array {
  const doc = parseSii(text);
  const w = new Writer();
  w.bytes(Uint8Array.from('BSII', (c) => c.charCodeAt(0)));
  w.u32(2);
  let structId = 1;
  for (const seg of doc.segments) {
    if (seg.kind !== 'unit') continue;
    const u = seg.unit;
    const fields: { name: string; type: number; write: (w: Writer) => void }[] = [];
    for (let i = 0; i < u.attrs.length; i++) {
      const [k, v] = u.attrs[i];
      // 配列: "k: N" に続いて k[0]..k[N-1]
      const n = /^\d+$/.test(v) ? Number(v) : -1;
      if (n > 0 && u.attrs[i + 1]?.[0] === `${k}[0]`) {
        const values = u.attrs.slice(i + 1, i + 1 + n).map((a) => a[1]);
        const enc = arrayEnc(values);
        if (!enc) throw new Error(`${u.type}.${k}: 配列の型を推定できません: ${values.slice(0, 3).join(' | ')}`);
        fields.push({ name: k, type: enc.type, write: (wr) => { wr.u32(n); enc.items.forEach((it) => it.write(wr)); } });
        i += n;
        continue;
      }
      const enc = scalar(v);
      if (!enc) throw new Error(`${u.type}.${k}: 型を推定できません: ${v}`);
      fields.push({ name: k, type: enc.type, write: enc.write });
    }
    // 構造体定義 (ユニットごとに 1 つ作る)
    w.u32(0);
    w.u8(1);
    w.u32(structId);
    w.str(u.type);
    for (const f of fields) { w.u32(f.type); w.str(f.name); }
    w.u32(0);
    // データ
    w.u32(structId++);
    writeId(w, u.id);
    for (const f of fields) f.write(w);
  }
  w.u32(0);
  w.u8(0);
  return w.result();
}

/** 中身を ScsC 形式で暗号化 */
export function encryptScsC(inner: Uint8Array): Uint8Array {
  const compressed = zlibSync(inner, { level: 6 });
  const pad = 16 - (compressed.length % 16);
  const padded = new Uint8Array(compressed.length + pad);
  padded.set(compressed);
  padded.fill(pad, compressed.length);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', SII_KEY, iv);
  c.setAutoPadding(false);
  const enc = Buffer.concat([c.update(padded), c.final()]);
  const out = new Uint8Array(56 + enc.length);
  out.set(Uint8Array.from('ScsC', (ch) => ch.charCodeAt(0)), 0);
  out.set(iv, 36);
  new DataView(out.buffer).setUint32(52, inner.length, true);
  out.set(enc, 56);
  return out;
}
