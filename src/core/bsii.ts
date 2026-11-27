/**
 * BSII (バイナリ SII) → テキスト SII デコーダ。
 *
 * フォーマット仕様と出力形式は SII_Decrypt (František Milt, MPL-2.0,
 * https://github.com/TheLazyTomcat/SII_Decrypt) の挙動に合わせている。
 * 出力は SII_Decrypt と同じく CRLF 改行・末尾改行なし。
 */

export class BsiiError extends Error {}

const EOL = '\r\n';
const TOKEN_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz_';

interface FieldDef {
  type: number;
  name: string;
  /** 0x37 / 0x38 (順序付き文字列) の対応表 */
  ordinals?: Map<number, string>;
}
interface StructDef {
  id: number;
  name: string;
  fields: FieldDef[];
}
interface Id {
  length: number;
  parts: bigint[];
}

class Reader {
  private view: DataView;
  private bytes: Uint8Array;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() {
    return this.bytes.length - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.bytes.length) throw new BsiiError(`データが途中で終わっています (offset ${this.pos})`);
  }
  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  /** float32 の生ビット */
  f32bits() {
    return this.u32();
  }
  rawString(): Uint8Array {
    const len = this.u32();
    this.need(len);
    const s = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  count() {
    const n = this.u32();
    // 異常に大きい配列長は壊れたデータとみなす
    if (n > this.remaining) throw new BsiiError(`配列長が不正です (${n}, offset ${this.pos - 4})`);
    return n;
  }
}

// ---- 値の文字列化 ---------------------------------------------------------

const f32buf = new DataView(new ArrayBuffer(4));
function bitsToFloat(bits: number) {
  f32buf.setUint32(0, bits);
  return f32buf.getFloat32(0);
}
function floatToBits(v: number) {
  f32buf.setFloat32(0, v);
  return f32buf.getUint32(0);
}

/** SII の float 表記: 整数かつ 1e7 未満なら 10 進、それ以外は &16進ビット */
export function floatToSii(bits: number): string {
  const v = bitsToFloat(bits);
  if (Number.isNaN(v) || v !== Math.trunc(v) || v >= 1e7) {
    return '&' + (bits >>> 0).toString(16).padStart(8, '0');
  }
  return Object.is(v, -0) ? '0' : v.toFixed(0);
}

function isLimitedAlphabet(s: string) {
  return /^[0-9A-Za-z_]*$/.test(s);
}

/** 文字列のバイト列を SII 表記に。非 ASCII を含む場合は \xNN でエスケープ (SII_Decrypt 互換) */
function bytesToSiiString(b: Uint8Array): string {
  let nonAscii = false;
  for (let i = 0; i < b.length; i++) if (b[i] > 127) { nonAscii = true; break; }
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (!nonAscii || (c >= 32 && c <= 127)) s += String.fromCharCode(c);
    else s += '\\x' + c.toString(16).padStart(2, '0');
  }
  return s;
}

function quoteIfNeeded(s: string) {
  return s.length > 0 && isLimitedAlphabet(s) ? s : `"${s}"`;
}

/** 64bit 値を base-38 のトークン文字列に復号 */
export function decodeToken(v: bigint): string {
  v &= ~(1n << 63n);
  let s = '';
  while (v !== 0n) {
    const idx = Number(v % 38n);
    v /= 38n;
    if (idx < 1) throw new BsiiError('トークンの復号に失敗しました');
    s += TOKEN_CHARS[idx - 1];
  }
  return s;
}

function idToString(id: Id, oldHexStyle: boolean): string {
  if (id.length === 0) return 'null';
  if (id.length === 0xff) {
    const v = id.parts[0];
    if (oldHexStyle && v >> 32n === 0n) {
      const hi = Number((v >> 16n) & 0xffffn).toString(16).toUpperCase().padStart(4, '0');
      const lo = Number(v & 0xffffn).toString(16).toUpperCase().padStart(4, '0');
      return `_nameless.${hi}.${lo}`;
    }
    if (v === 0n) return '_nameless.0';
    let t = v;
    let s = '';
    while (t !== 0n) {
      const w = Number(t & 0xffffn).toString(16);
      s = '.' + (t >> 16n !== 0n ? w.padStart(4, '0') : w) + s;
      t >>= 16n;
    }
    return '_nameless' + s;
  }
  try {
    return id.parts.map(decodeToken).join('.');
  } catch {
    return 'null'; // SII_Decrypt と同様、復号できない ID は null として扱う
  }
}

function readId(r: Reader): Id {
  const length = r.u8();
  const n = length === 0xff ? 1 : length;
  const parts: bigint[] = [];
  for (let i = 0; i < n; i++) parts.push(r.u64());
  return { length, parts };
}

const nilU32 = (v: number) => (v === 0xffffffff ? 'nil' : String(v));
const nilU16 = (v: number) => (v === 0xffff ? 'nil' : String(v));
const nilU64 = (v: bigint) =>
  (v & 0xffffffffn) === 0xffffffffn || v >> 32n === 0xffffffffn ? 'nil' : v.toString();

function vec(r: Reader, n: number) {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(floatToSii(r.f32bits()));
  return parts;
}

function placement(r: Reader, version: number): string {
  let v: number[];
  if (version === 1) {
    const a = [r.f32bits(), r.f32bits(), r.f32bits()].map(bitsToFloat);
    const b = [r.f32bits(), r.f32bits(), r.f32bits(), r.f32bits()].map(bitsToFloat);
    v = [...a, 0, ...b];
  } else {
    v = [];
    for (let i = 0; i < 8; i++) v.push(bitsToFloat(r.f32bits()));
    // 座標の上位ビットが 4 番目の要素に格納されている
    const coef = Math.trunc(v[3]);
    v[0] = Math.fround(v[0] + (((coef & 0xfff) - 2048) << 9));
    v[2] = Math.fround(v[2] + ((((coef >> 12) & 0xfff) - 2048) << 9));
  }
  const f = (x: number) => floatToSii(floatToBits(x));
  return `(${f(v[0])}, ${f(v[1])}, ${f(v[2])}) (${f(v[4])}; ${f(v[5])}, ${f(v[6])}, ${f(v[7])})`;
}

/** 単一値の読み取り。配列型は null を返す */
function readScalar(r: Reader, f: FieldDef, version: number): string | null {
  switch (f.type) {
    case 0x01: return quoteIfNeeded(bytesToSiiString(r.rawString()));
    case 0x03: { const v = r.u64(); return v === 0n ? '""' : decodeToken(v); }
    case 0x05: return floatToSii(r.f32bits());
    case 0x07: return `(${vec(r, 2).join(', ')})`;
    case 0x09: return `(${vec(r, 3).join(', ')})`;
    case 0x11: return `(${r.i32()}, ${r.i32()}, ${r.i32()})`;
    case 0x17: { const q = vec(r, 4); return `(${q[0]}; ${q[1]}, ${q[2]}, ${q[3]})`; }
    case 0x19: return placement(r, version);
    case 0x25: return String(r.i32());
    case 0x27: return nilU32(r.u32());
    case 0x29: return String(r.i16());
    case 0x2b: return nilU16(r.u16());
    case 0x2f: return String(r.u32());
    case 0x31: return r.i64().toString();
    case 0x33: return nilU64(r.u64());
    case 0x35: return r.u8() !== 0 ? 'true' : 'false';
    case 0x37: return quoteIfNeeded(ordinal(f, r.u32()));
    case 0x39: case 0x3b: case 0x3d: return idToString(readId(r), version < 2);
    default: return null;
  }
}

/** 配列要素の読み取り関数 (配列型 → 要素の書式化) */
function arrayElementReader(type: number, f: FieldDef, version: number): ((r: Reader) => string) | null {
  switch (type) {
    case 0x02: return (r) => quoteIfNeeded(bytesToSiiString(r.rawString()));
    case 0x04: return (r) => { const v = r.u64(); return v === 0n ? '""' : decodeToken(v); };
    case 0x06: return (r) => floatToSii(r.f32bits());
    case 0x08: return (r) => `(${vec(r, 2).join(', ')})`;
    case 0x0a: return (r) => `(${vec(r, 3).join(', ')})`;
    case 0x12: return (r) => `(${r.i32()}, ${r.i32()}, ${r.i32()})`;
    case 0x18: return (r) => { const q = vec(r, 4); return `(${q[0]}; ${q[1]}, ${q[2]}, ${q[3]})`; };
    case 0x1a: return (r) => placement(r, version);
    case 0x26: return (r) => String(r.i32());
    case 0x28: return (r) => nilU32(r.u32());
    case 0x2a: return (r) => String(r.i16());
    case 0x2c: return (r) => nilU16(r.u16());
    case 0x32: return (r) => r.i64().toString();
    case 0x34: return (r) => nilU64(r.u64());
    case 0x36: return (r) => (r.u8() !== 0 ? 'true' : 'false');
    case 0x38: return (r) => quoteIfNeeded(ordinal(f, r.u32()));
    case 0x3a: case 0x3c: case 0x3e: return (r) => idToString(readId(r), version < 2);
    default: return null;
  }
}

function ordinal(f: FieldDef, v: number): string {
  const s = f.ordinals?.get(v);
  if (s === undefined) throw new BsiiError(`${f.name}: 順序値 ${v} に対応する文字列がありません`);
  return s;
}

function readFieldLines(r: Reader, f: FieldDef, version: number, out: string[]) {
  const scalar = readScalar(r, f, version);
  if (scalar !== null) {
    out.push(` ${f.name}: ${scalar}`);
    return;
  }
  const elem = arrayElementReader(f.type, f, version);
  if (!elem) throw new BsiiError(`未対応の値型 0x${f.type.toString(16)} (${f.name})`);
  const n = r.count();
  out.push(` ${f.name}: ${n}`);
  for (let i = 0; i < n; i++) out.push(` ${f.name}[${i}]: ${elem(r)}`);
}

const SUPPORTED = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x11, 0x12, 0x17, 0x18, 0x19, 0x1a,
  0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2f, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
  0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e,
]);

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** BSII バイナリをテキスト SII に変換する */
export function decodeBsii(bytes: Uint8Array): string {
  const r = new Reader(bytes);
  if (r.remaining < 8 || latin1(bytes.subarray(0, 4)) !== 'BSII') throw new BsiiError('BSII 形式ではありません');
  r.pos = 4;
  const version = r.u32();
  const structs = new Map<number, StructDef>();
  const out: string[] = ['SiiNunit', '{'];

  for (;;) {
    const blockType = r.u32();
    if (blockType === 0) {
      // 構造体定義ブロック
      const valid = r.u8() !== 0;
      if (!valid) break; // ファイル終端
      const id = r.u32();
      if (id === 0 || structs.has(id)) throw new BsiiError(`構造体 ID が不正です (${id})`);
      const name = latin1(r.rawString());
      const fields: FieldDef[] = [];
      for (;;) {
        const type = r.u32();
        if (type === 0) break;
        if (!SUPPORTED.has(type)) throw new BsiiError(`未対応の値型 0x${type.toString(16)} (構造体 ${name})`);
        const field: FieldDef = { type, name: latin1(r.rawString()) };
        if (type === 0x37 || type === 0x38) {
          const n = r.count();
          field.ordinals = new Map();
          for (let i = 0; i < n; i++) {
            const ord = r.u32();
            field.ordinals.set(ord, bytesToSiiString(r.rawString()));
          }
        }
        fields.push(field);
      }
      structs.set(id, { id, name, fields });
    } else {
      // データブロック
      const def = structs.get(blockType);
      if (!def) throw new BsiiError(`未定義の構造体 ID ${blockType} (offset ${r.pos - 4})`);
      const blockId = idToString(readId(r), version < 2);
      out.push(`${def.name} : ${blockId} {`);
      for (const f of def.fields) readFieldLines(r, f, version, out);
      out.push('}', '');
    }
  }
  out.push('}');
  return out.join(EOL);
}
