import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { getArray, parseSii, serializeSii, setArray, detectFormat } from '../src/core/sii';
import { SaveGame, bigIntToNameless, formatGameTime, namelessToBigInt, type JobSpec } from '../src/core/save';

const text = readFileSync(new URL('./fixtures/mini.sii', import.meta.url), 'utf8');

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
  source: 'company.volatile.posped.sofia', slot: 'new', target: 'medas.athens', cargo: 'cargo.used_plast',
  trailerVariant: 'trailer.scs_dry_s', trailerDefinition: 'trailer_def.scs.box.single_3.dryvan',
  unitsCount: 33, fillRatio: 1, urgency: 2, distanceKm: 450, ferryTime: 0, ferryPrice: 0,
  expirationHours: 10, companyTruck: 'daf_xd_2', ...over,
});

describe('sii', () => {
  test('往復でテキストが一致する (CRLF)', () => {
    expect(serializeSii(parseSii(text))).toBe(text);
  });
  test('LF でも一致する', () => {
    const lf = text.replace(/\r\n/g, '\n');
    expect(serializeSii(parseSii(lf))).toBe(lf);
  });
  test('setArray で配列を置き換える', () => {
    const doc = parseSii(text);
    const u = doc.segments.flatMap((s) => (s.kind === 'unit' ? [s.unit] : []))[1];
    setArray(u, 'job_offer', ['a', 'b']);
    expect(getArray(u, 'job_offer')).toEqual(['a', 'b']);
    expect(u.attrs.map((a) => a[0])).toEqual(['permanent_data', 'job_offer', 'job_offer[0]', 'job_offer[1]', 'discovered', 'state']);
  });
  test('形式判定', () => {
    expect(detectFormat(new TextEncoder().encode('SiiNunit'))).toBe('text');
    expect(detectFormat(new TextEncoder().encode('ScsC....'))).toBe('encrypted');
    expect(detectFormat(new TextEncoder().encode('BSII....'))).toBe('binary');
  });
});

describe('SaveGame', () => {
  test('会社・オファー・カタログを読み取る', () => {
    const s = SaveGame.fromText(text);
    expect(s.gameTime).toBe(1500);
    expect(s.companies.size).toBe(2);
    expect(s.companyByKey.get('posped.sofia')).toBe('company.volatile.posped.sofia');
    const cargo = s.cargoes.get('cargo.used_plast')!;
    expect(cargo.trailers[0]).toMatchObject({ variant: 'trailer.scs_dry_s', unitsCount: 33 });
    expect(s.findRoute('medas.athens', 'posped.sofia')?.distanceKm).toBe(441);
    // 逆方向は都市ペアで推定
    expect(s.findRoute('posped.sofia', 'medas.athens')).toMatchObject({ distanceKm: 441, accuracy: 'city' });
  });

  test('新規オファーを追加する', () => {
    const s = SaveGame.fromText(text);
    const id = s.applyJob(spec());
    expect(id).toBe('_nameless.1a6.2f64.77f8');
    const r = SaveGame.fromText(s.serialize());
    expect(r.companies.get('company.volatile.posped.sofia')!.offerIds).toEqual([id]);
    expect(r.offers.get(id)).toMatchObject({ target: 'medas.athens', expirationTime: 1500 + 600, urgency: 2, unitsCount: 33 });
  });

  test('既存スロットを上書きする', () => {
    const s = SaveGame.fromText(text);
    const id = s.applyJob(spec({ source: 'company.volatile.medas.athens', slot: 0, target: 'posped.sofia', distanceKm: 999 }));
    expect(id).toBe('_nameless.1a6.2f64.77e8');
    const r = SaveGame.fromText(s.serialize());
    expect(r.offers.get(id)!.distanceKm).toBe(999);
    expect(r.offers.size).toBe(1);
  });

  test('不正な仕様はエラー', () => {
    const s = SaveGame.fromText(text);
    expect(s.validate(spec({ target: 'nope.city' })).errors.length).toBeGreaterThan(0);
    expect(s.validate(spec({ target: 'posped.sofia' })).errors).toContain('出発地と配送先が同じです');
    expect(() => s.applyJob(spec({ unitsCount: 0 }))).toThrow();
    expect(s.validate(spec()).warnings).toContain('この会社がこのカーゴを出荷した実績はセーブ内にありません');
  });
});

test('nameless ID 変換', () => {
  const id = '_nameless.1a6.2f64.07e8';
  expect(bigIntToNameless(namelessToBigInt(id)!)).toBe(id);
  expect(bigIntToNameless(namelessToBigInt('_nameless.1a6.ffff.fff8')! + 0x10n)).toBe('_nameless.1a7.0000.0008');
});

test('ゲーム内時刻の表示', () => {
  expect(formatGameTime(1500)).toBe('Day 2 (火) 01:00');
});
