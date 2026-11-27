/**
 * ETS2 / ATS のセーブファイル (game.sii など) の復号。
 *
 *  ScsC : AES-256-CBC で暗号化 + zlib 圧縮された中身 (中身は BSII かテキスト)
 *  BSII : バイナリ SII → テキストに変換
 *  SiiNunit : そのまま
 *
 * 鍵とヘッダー構造は SII_Decrypt (MPL-2.0, https://github.com/TheLazyTomcat/SII_Decrypt) を参照。
 */
import { inflateSync } from 'fflate';
import { aesCbcDecrypt } from './aes.ts';
import { decodeBsii } from './bsii.ts';

export type SaveFormat = 'text' | 'encrypted' | 'binary' | '3nK' | 'unknown';

export const SII_KEY = new Uint8Array([
  0x2a, 0x5f, 0xcb, 0x17, 0x91, 0xd2, 0x2f, 0xb6, 0x02, 0x45, 0xb3, 0xd8, 0x36, 0x9e, 0xd0, 0xb2,
  0xc2, 0x73, 0x71, 0x56, 0x3f, 0xbf, 0x1f, 0x3c, 0x9e, 0xdf, 0x6b, 0x11, 0x82, 0x5a, 0x5d, 0x0a,
]);

/** ScsC ヘッダー: signature(4) + HMAC(32) + IV(16) + 展開後サイズ(4) */
const SCSC_HEADER_SIZE = 4 + 32 + 16 + 4;

export class DecryptError extends Error {}

export function detectSaveFormat(bytes: Uint8Array): SaveFormat {
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic.startsWith('SiiNunit')) return 'text';
  if (magic.startsWith('﻿SiiNunit')) return 'text';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && magic.slice(3).startsWith('SiiNu')) return 'text';
  if (magic.startsWith('ScsC')) return 'encrypted';
  if (magic.startsWith('BSII')) return 'binary';
  if (magic.startsWith('3nK')) return '3nK';
  return 'unknown';
}

/** ScsC を復号・展開して中身 (BSII またはテキストのバイト列) を返す */
export function decryptScsC(bytes: Uint8Array): Uint8Array {
  if (bytes.length < SCSC_HEADER_SIZE) throw new DecryptError('ファイルが短すぎます');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iv = bytes.subarray(36, 52);
  const dataSize = view.getUint32(52, true);
  let payload = bytes.subarray(SCSC_HEADER_SIZE);
  payload = payload.subarray(0, payload.length - (payload.length % 16));
  const decrypted = aesCbcDecrypt(SII_KEY, iv, payload);

  // zlib ヘッダー (2 バイト) を確認し、末尾のパディングは無視して raw deflate として展開する
  const cmf = decrypted[0];
  const flg = decrypted[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) {
    throw new DecryptError('復号に失敗しました (zlib ヘッダーが不正です)。対応していない形式の可能性があります。');
  }
  let out: Uint8Array;
  try {
    out = inflateSync(decrypted.subarray(2), { out: new Uint8Array(dataSize) });
  } catch (e) {
    throw new DecryptError(`展開に失敗しました: ${(e as Error).message}`);
  }
  if (out.length !== dataSize) throw new DecryptError(`展開後のサイズが一致しません (${out.length} / ${dataSize})`);
  return out;
}

export interface DecodedSave {
  /** テキスト形式の SII */
  text: string;
  /** 元ファイルの形式 */
  sourceFormat: SaveFormat;
  /** 中身の形式 (ScsC の場合は復号後の形式) */
  innerFormat: SaveFormat;
}

/** どの形式のセーブファイルでもテキスト SII に変換する */
export function decodeSaveFile(bytes: Uint8Array): DecodedSave {
  const sourceFormat = detectSaveFormat(bytes);
  let inner = bytes;
  if (sourceFormat === 'encrypted') inner = decryptScsC(bytes);
  const innerFormat = detectSaveFormat(inner);

  switch (innerFormat) {
    case 'text':
      return { text: new TextDecoder('utf-8').decode(inner), sourceFormat, innerFormat };
    case 'binary':
      return { text: decodeBsii(inner), sourceFormat, innerFormat };
    case '3nK':
      throw new DecryptError('3nK 形式には対応していません。');
    case 'encrypted':
      throw new DecryptError('二重に暗号化されたファイルには対応していません。');
    default:
      throw new DecryptError('ETS2 / ATS のセーブファイルではないようです (形式を判別できません)。');
  }
}
