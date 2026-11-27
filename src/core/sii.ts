/**
 * SII テキスト形式 (復号済み game.sii) のパーサ / シリアライザ。
 *
 * 方針:
 *  - 変更していないユニットは元のテキストをそのまま出力する（バイト単位で同一）。
 *  - 変更したユニット / 新規ユニットのみ再シリアライズする。
 *  - 改行コード (CRLF / LF) は元ファイルに合わせる。
 */

export interface SiiUnit {
  /** ユニット型 (例: company, job_offer_data) */
  type: string;
  /** ユニット ID (例: company.volatile.medas.athens, _nameless.1a6.2f64.77e8) */
  id: string;
  /** 属性 (出現順)。配列は `key: N` と `key[i]: v` の行として保持する */
  attrs: [string, string][];
  /** 元テキスト (未変更時の出力に使う)。変更すると undefined になる */
  raw?: string;
}

export type SiiSegment = { kind: 'text'; text: string } | { kind: 'unit'; unit: SiiUnit };

export interface SiiDocument {
  segments: SiiSegment[];
  eol: '\r\n' | '\n';
}

const UNIT_START = /^(\w+)\s*:\s*([^\s{]+)\s*\{\s*$/;

export class SiiParseError extends Error {}

export function parseSii(text: string): SiiDocument {
  const eol: '\r\n' | '\n' = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.startsWith('SiiNunit')) {
    throw new SiiParseError('SiiNunit ヘッダーがありません。復号化済みのテキスト形式 game.sii を指定してください。');
  }

  const lines = text.split(/\r?\n/);
  const segments: SiiSegment[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length) segments.push({ kind: 'text', text: textBuf.join(eol) + eol });
    textBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = UNIT_START.exec(line);
    // 最上位の "SiiNunit {" の "{" 単独行は UNIT_START に一致しない
    if (!m) {
      textBuf.push(line);
      continue;
    }
    flushText();
    const start = i;
    const attrs: [string, string][] = [];
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l === '}') break;
      if (l === '') continue;
      const p = l.indexOf(':');
      if (p < 0) throw new SiiParseError(`行 ${i + 1}: 属性行を解釈できません: ${l}`);
      attrs.push([l.slice(0, p).trim(), l.slice(p + 1).trim()]);
    }
    if (i >= lines.length) throw new SiiParseError(`行 ${start + 1}: ユニット ${m[2]} が閉じられていません`);
    const raw = lines.slice(start, i + 1).join(eol) + eol;
    segments.push({ kind: 'unit', unit: { type: m[1], id: m[2], attrs, raw } });
  }

  // split の最後の空要素 (末尾改行) を除去して元テキストを再現
  if (textBuf.length && textBuf[textBuf.length - 1] === '') {
    textBuf.pop();
    flushText();
  } else if (textBuf.length) {
    segments.push({ kind: 'text', text: textBuf.join(eol) });
  }
  return { segments, eol };
}

export function serializeUnit(u: SiiUnit, eol: string): string {
  const body = u.attrs.map(([k, v]) => ` ${k}: ${v}`).join(eol);
  return `${u.type} : ${u.id} {${eol}${body}${body ? eol : ''}}${eol}`;
}

export function serializeSii(doc: SiiDocument): string {
  let out = '';
  for (const s of doc.segments) {
    if (s.kind === 'text') out += s.text;
    else out += s.unit.raw ?? serializeUnit(s.unit, doc.eol);
  }
  return out;
}

// ---- 属性ヘルパ ---------------------------------------------------------

export function getAttr(u: SiiUnit, key: string): string | undefined {
  for (const [k, v] of u.attrs) if (k === key) return v;
  return undefined;
}

export function setAttr(u: SiiUnit, key: string, value: string): void {
  u.raw = undefined;
  for (const a of u.attrs) {
    if (a[0] === key) {
      a[1] = value;
      return;
    }
  }
  u.attrs.push([key, value]);
}

export function getArray(u: SiiUnit, key: string): string[] {
  const out: string[] = [];
  const prefix = key + '[';
  for (const [k, v] of u.attrs) {
    if (k.startsWith(prefix) && k.endsWith(']')) out.push(v);
  }
  return out;
}

/** 配列属性を置き換える。`key: N` 行の位置を保ち、その直後に要素行を並べる */
export function setArray(u: SiiUnit, key: string, values: string[]): void {
  u.raw = undefined;
  const prefix = key + '[';
  let pos = u.attrs.findIndex(([k]) => k === key);
  const kept = u.attrs.filter(([k]) => !(k.startsWith(prefix) && k.endsWith(']')));
  if (pos < 0) {
    kept.push([key, '0']);
    pos = kept.length - 1;
  } else {
    pos = kept.findIndex(([k]) => k === key);
  }
  kept[pos] = [key, String(values.length)];
  kept.splice(pos + 1, 0, ...values.map((v, i) => [`${key}[${i}]`, v] as [string, string]));
  u.attrs = kept;
}

/** SII 文字列値のクォート */
export function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}
