/**
 * 実際のセーブデータでの動作確認。ETS2_SAVE に復号済み game.sii のパスを指定したときだけ実行される。
 *   ETS2_SAVE=/path/to/game.sii npm test
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SaveGame } from '../src/core/save';

const path = process.env.ETS2_SAVE;

describe.skipIf(!path)('実セーブデータ', () => {
  test('無変更で往復するとバイト単位で一致し、仕事を追加できる', () => {
    const text = readFileSync(path!, 'utf8');
    const save = SaveGame.fromText(text);
    expect(save.serialize()).toBe(text);

    const [cargoId, cargo] = [...save.cargoes].sort((a, b) => b[1].count - a[1].count)[0];
    const sourceKey = [...cargo.sources][0];
    const targetKey = [...cargo.targets].find((t) => t !== sourceKey)!;
    const tr = cargo.trailers[0];
    const id = save.applyJob({
      source: save.companyByKey.get(sourceKey)!, slot: 'new', target: targetKey, cargo: cargoId,
      trailerVariant: tr.variant, trailerDefinition: tr.definition, unitsCount: tr.unitsCount, fillRatio: tr.fillRatio,
      urgency: 0, distanceKm: 500, ferryTime: 0, ferryPrice: 0, expirationHours: 24, companyTruck: [...save.trucks.keys()][0],
    });
    const out = save.serialize();
    const reloaded = SaveGame.fromText(out);
    expect(reloaded.offers.get(id)?.target).toBe(targetKey);
    expect(reloaded.companies.get(save.companyByKey.get(sourceKey)!)?.offerIds).toContain(id);
    expect(out.split('\r\n').length - text.split('\r\n').length).toBe(17); // 新規ユニット 15 行 + 空行 + job_offer[n] 行
  });
});

describe.skipIf(!path)('実セーブデータの暗号化 → 復号', () => {
  test('BSII + ScsC に変換して復号するとバイト単位で一致する', async () => {
    const { encodeBsii, encryptScsC } = await import('./helpers/bsii-encode');
    const { decodeSaveFile } = await import('../src/core/decrypt');
    const text = readFileSync(path!, 'utf8');
    const d = decodeSaveFile(encryptScsC(encodeBsii(text)));
    expect(d.innerFormat).toBe('binary');
    expect(d.text === text).toBe(true);
  });
});
