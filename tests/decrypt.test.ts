import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { aesCbcDecrypt } from '../src/core/aes';
import { decodeBsii, decodeToken, floatToSii } from '../src/core/bsii';
import { decodeSaveFile, detectSaveFormat } from '../src/core/decrypt';
import { encodeBsii, encodeToken, encryptScsC } from './helpers/bsii-encode';

// SII_Decrypt 互換の出力は末尾改行なしなので、フィクスチャもそれに合わせる
const mini = readFileSync(new URL('./fixtures/mini.sii', import.meta.url), 'utf8').replace(/\r\n$/, '');
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

test('AES-CBC 復号が Node の crypto と一致する', () => {
  for (const len of [16, 24, 32]) {
    const key = randomBytes(len), iv = randomBytes(16), pt = randomBytes(16 * 37);
    const c = createCipheriv(`aes-${len * 8}-cbc`, key, iv);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    expect(Buffer.from(aesCbcDecrypt(key, iv, ct)).equals(pt)).toBe(true);
  }
});

test('形式判定', () => {
  expect(detectSaveFormat(ascii('SiiNunit\r\n{'))).toBe('text');
  expect(detectSaveFormat(ascii('ScsC....'))).toBe('encrypted');
  expect(detectSaveFormat(ascii('BSII....'))).toBe('binary');
  expect(detectSaveFormat(ascii('hello...'))).toBe('unknown');
});

test('トークン・float の表記', () => {
  expect(decodeToken(encodeToken('daf_xd_2'))).toBe('daf_xd_2');
  expect(floatToSii(0x3f800000)).toBe('1');
  expect(floatToSii(0x3fc00000)).toBe('&3fc00000'); // 1.5
  expect(floatToSii(0x4b189680)).toBe('&4b189680'); // 1e7
  expect(floatToSii(0xc0400000)).toBe('-3');
});

describe('ScsC / BSII', () => {
  test('テキスト → BSII → テキストで一致する', () => {
    expect(decodeBsii(encodeBsii(mini))).toBe(mini);
  });

  test('暗号化 (ScsC + BSII) を復号できる', () => {
    const d = decodeSaveFile(encryptScsC(encodeBsii(mini)));
    expect(d).toMatchObject({ sourceFormat: 'encrypted', innerFormat: 'binary' });
    expect(d.text).toBe(mini);
  });

  test('暗号化 (ScsC + テキスト) を復号できる', () => {
    const d = decodeSaveFile(encryptScsC(ascii(mini)));
    expect(d).toMatchObject({ sourceFormat: 'encrypted', innerFormat: 'text', text: mini });
  });

  test('鍵が違うと分かりやすいエラーになる', () => {
    const enc = encryptScsC(encodeBsii(mini));
    enc[60] ^= 0xff; // 先頭ブロックを壊す
    expect(() => decodeSaveFile(enc)).toThrow(/復号|展開/);
  });
});

/** 手組みの BSII で、往復テストでは出ない型をテスト */
describe('BSII の各値型', () => {
  class W {
    b: number[] = [];
    u8(v: number) { this.b.push(v & 0xff); return this; }
    u16(v: number) { const d = new DataView(new ArrayBuffer(2)); d.setUint16(0, v, true); this.b.push(...new Uint8Array(d.buffer)); return this; }
    u32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, v >>> 0, true); this.b.push(...new Uint8Array(d.buffer)); return this; }
    f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); this.b.push(...new Uint8Array(d.buffer)); return this; }
    u64(v: bigint) { const d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, v, true); this.b.push(...new Uint8Array(d.buffer)); return this; }
    str(s: string | number[]) { const a = typeof s === 'string' ? [...ascii(s)] : s; this.u32(a.length); this.b.push(...a); return this; }
  }
  function build(version: number, fields: [number, string, ((w: W) => void)?][], data: (w: W) => void, id: (w: W) => void) {
    const w = new W();
    w.b.push(...ascii('BSII'));
    w.u32(version).u32(0).u8(1).u32(7).str('test_unit');
    for (const [t, n, extra] of fields) { w.u32(t).str(n); extra?.(w); }
    w.u32(0).u32(7);
    id(w);
    data(w);
    w.u32(0).u8(0);
    return decodeBsii(Uint8Array.from(w.b)).split('\r\n');
  }

  test('placement の座標係数・nil・順序付き文字列・非 ASCII 文字列', () => {
    const lines = build(
      2,
      [
        [0x19, 'pos'],
        [0x33, 'big'],
        [0x2b, 'small'],
        [0x37, 'kind', (w) => w.u32(2).u32(0).str('first').u32(5).str('with space')],
        [0x01, 'name'],
        [0x36, 'flags'],
        [0x3a, 'refs'],
      ],
      (w) => {
        // x = 10.5 + (2049-2048)<<9 = 522.5, z = 0 + (2046-2048)<<9 = -1024
        w.f32(10.5).f32(2).f32(0).f32(2049 + (2046 << 12)).f32(1).f32(0).f32(0).f32(0);
        w.u64(0xffffffffffffffffn);
        w.u16(0xffff);
        w.u32(5);
        w.str([0x41, 0xe3, 0x81, 0x82]); // "Aあ" (UTF-8)
        w.u32(2).u8(1).u8(0);
        w.u32(3).u8(0).u8(0xff).u64(0x1a62f6477e8n).u8(2).u64(encodeToken('cargo')).u64(encodeToken('wood'));
      },
      (w) => w.u8(0xff).u64(0x1a6245496b8n),
    );
    expect(lines).toEqual([
      'SiiNunit', '{',
      'test_unit : _nameless.1a6.2454.96b8 {',
      ' pos: (&4402a000, 2, -1024) (1; 0, 0, 0)',
      ' big: nil',
      ' small: nil',
      ' kind: "with space"',
      ' name: "A\\xe3\\x81\\x82"',
      ' flags: 2', ' flags[0]: true', ' flags[1]: false',
      ' refs: 3', ' refs[0]: null', ' refs[1]: _nameless.1a6.2f64.77e8', ' refs[2]: cargo.wood',
      '}', '', '}',
    ]);
  });

  test('バージョン 1 の旧 nameless 表記', () => {
    const lines = build(1, [[0x25, 'v']], (w) => w.u32(-5), (w) => w.u8(0xff).u64(0x12abn));
    expect(lines[2]).toBe('test_unit : _nameless.0000.12AB {');
    expect(lines[3]).toBe(' v: -5');
  });

  test('未対応の型はエラー', () => {
    expect(() => build(2, [[0x99, 'x']], () => {}, (w) => w.u8(0))).toThrow(/未対応/);
  });
});
