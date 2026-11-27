/**
 * game.sii の経済データ (会社・仕事オファー) を扱うモデルと、仕事作成ロジック。
 * DOM には依存しないので、Electron / Tauri のメイン側や CLI からもそのまま使える。
 */
import {
  type SiiDocument,
  type SiiUnit,
  getArray,
  getAttr,
  parseSii,
  quote,
  serializeSii,
  setArray,
  unquote,
} from './sii.ts';

export interface CompanyInfo {
  /** ユニット ID: company.volatile.<name>.<city> */
  id: string;
  /** 仕事の target に使うキー: <name>.<city> */
  key: string;
  name: string;
  city: string;
  discovered: boolean;
  /** job_offer 配列 (job_offer_data のユニット ID) */
  offerIds: string[];
}

export interface JobOffer {
  id: string;
  target: string;
  expirationTime: number | null;
  urgency: number | null;
  distanceKm: number;
  ferryTime: number;
  ferryPrice: number;
  cargo: string | null;
  companyTruck: string;
  trailerVariant: string | null;
  trailerDefinition: string;
  unitsCount: number;
  fillRatio: number;
  trailerPlace: number;
}

export interface TrailerOption {
  definition: string;
  variant: string;
  unitsCount: number;
  fillRatio: number;
  /** セーブ内で観測された回数 */
  count: number;
}

export interface CargoInfo {
  id: string;
  count: number;
  trailers: TrailerOption[];
  /** このカーゴを出荷している会社キー */
  sources: Set<string>;
  /** このカーゴの配送先になっている会社キー */
  targets: Set<string>;
}

export interface RouteInfo {
  distanceKm: number;
  ferryTime: number;
  ferryPrice: number;
  /** exact: 同じ会社→会社の実績 / city: 同じ都市→都市の実績 */
  accuracy: 'exact' | 'city';
}

export interface JobSpec {
  /** 出発会社のユニット ID (company.volatile.x.y) */
  source: string;
  /** 'new' なら新しいオファーを追加、数値なら job_offer[slot] を上書き */
  slot: number | 'new';
  /** 配送先 <name>.<city> */
  target: string;
  cargo: string;
  trailerVariant: string;
  trailerDefinition: string;
  unitsCount: number;
  fillRatio: number;
  urgency: 0 | 1 | 2;
  distanceKm: number;
  ferryTime: number;
  ferryPrice: number;
  /** 期限 (現在のゲーム内時刻からの時間) */
  expirationHours: number;
  companyTruck: string;
  trailerPlace?: number;
}

export class SaveError extends Error {}

const num = (v: string | undefined, d = 0): number => {
  if (v === undefined || v === 'nil' || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const nullable = (v: string | undefined): string | null =>
  v === undefined || v === 'null' || v === 'nil' || v === '""' ? null : v;

export function parseJobOffer(u: SiiUnit): JobOffer {
  const exp = getAttr(u, 'expiration_time');
  const urg = getAttr(u, 'urgency');
  return {
    id: u.id,
    target: unquote(getAttr(u, 'target') ?? '""'),
    expirationTime: exp === undefined || exp === 'nil' ? null : num(exp),
    urgency: urg === undefined || urg === 'nil' ? null : num(urg),
    distanceKm: num(getAttr(u, 'shortest_distance_km')),
    ferryTime: num(getAttr(u, 'ferry_time')),
    ferryPrice: num(getAttr(u, 'ferry_price')),
    cargo: nullable(getAttr(u, 'cargo')),
    companyTruck: getAttr(u, 'company_truck') ?? '',
    trailerVariant: nullable(getAttr(u, 'trailer_variant')),
    trailerDefinition: getAttr(u, 'trailer_definition') ?? '',
    unitsCount: num(getAttr(u, 'units_count')),
    fillRatio: num(getAttr(u, 'fill_ratio'), 1),
    trailerPlace: num(getAttr(u, 'trailer_place')),
  };
}

export const isEmptyOffer = (o: JobOffer) => o.target === '' || o.cargo === null;

/** ゲーム内時刻 (分) を "Day 12 (火) 05:59" 形式に */
export function formatGameTime(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const rem = minutes - days * 1440;
  const wd = ['月', '火', '水', '木', '金', '土', '日'][days % 7];
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return `Day ${days + 1} (${wd}) ${hh}:${mm}`;
}

// ---- nameless ID --------------------------------------------------------

const NAMELESS = /^_nameless\.([0-9a-f]+)\.([0-9a-f]{4})\.([0-9a-f]{4})$/;

export function namelessToBigInt(id: string): bigint | null {
  const m = NAMELESS.exec(id);
  if (!m) return null;
  return BigInt('0x' + m[1] + m[2] + m[3]);
}

export function bigIntToNameless(v: bigint): string {
  const hex = v.toString(16).padStart(9, '0');
  const a = hex.slice(0, -8).replace(/^0+(?=.)/, '');
  return `_nameless.${a}.${hex.slice(-8, -4)}.${hex.slice(-4)}`;
}

// ---- SaveGame -----------------------------------------------------------

export class SaveGame {
  readonly doc: SiiDocument;
  readonly units = new Map<string, SiiUnit>();
  readonly companies = new Map<string, CompanyInfo>();
  /** target キー (<name>.<city>) → 会社ユニット ID */
  readonly companyByKey = new Map<string, string>();
  readonly offers = new Map<string, JobOffer>();
  readonly cargoes = new Map<string, CargoInfo>();
  readonly trucks = new Map<string, number>();
  readonly gameTime: number;
  private routes = new Map<string, RouteInfo>();
  private cityRoutes = new Map<string, RouteInfo>();
  private maxNameless = 0n;

  constructor(doc: SiiDocument) {
    this.doc = doc;
    let economy: SiiUnit | undefined;
    for (const s of doc.segments) {
      if (s.kind !== 'unit') continue;
      const u = s.unit;
      this.units.set(u.id, u);
      const n = namelessToBigInt(u.id);
      if (n !== null && n > this.maxNameless) this.maxNameless = n;
      if (u.type === 'economy') economy = u;
    }
    if (!economy) throw new SaveError('economy ユニットが見つかりません。game.sii ではない可能性があります。');
    this.gameTime = num(getAttr(economy, 'game_time'));

    for (const s of doc.segments) {
      if (s.kind !== 'unit') continue;
      const u = s.unit;
      if (u.type === 'company' && u.id.startsWith('company.volatile.')) {
        const key = u.id.slice('company.volatile.'.length);
        const dot = key.indexOf('.');
        const info: CompanyInfo = {
          id: u.id,
          key,
          name: key.slice(0, dot),
          city: key.slice(dot + 1),
          discovered: getAttr(u, 'discovered') === 'true',
          offerIds: getArray(u, 'job_offer'),
        };
        this.companies.set(u.id, info);
        this.companyByKey.set(key, u.id);
      } else if (u.type === 'job_offer_data') {
        this.offers.set(u.id, parseJobOffer(u));
      }
    }
    this.buildCatalog();
  }

  static fromText(text: string): SaveGame {
    return new SaveGame(parseSii(text));
  }

  private buildCatalog() {
    for (const c of this.companies.values()) {
      for (const oid of c.offerIds) {
        const o = this.offers.get(oid);
        if (!o) continue;
        if (o.companyTruck) this.trucks.set(o.companyTruck, (this.trucks.get(o.companyTruck) ?? 0) + 1);
        if (isEmptyOffer(o) || !o.cargo || !o.trailerVariant) continue;

        let cargo = this.cargoes.get(o.cargo);
        if (!cargo) {
          cargo = { id: o.cargo, count: 0, trailers: [], sources: new Set(), targets: new Set() };
          this.cargoes.set(o.cargo, cargo);
        }
        cargo.count++;
        cargo.sources.add(c.key);
        cargo.targets.add(o.target);
        let t = cargo.trailers.find(
          (x) =>
            x.definition === o.trailerDefinition &&
            x.variant === o.trailerVariant &&
            x.unitsCount === o.unitsCount &&
            x.fillRatio === o.fillRatio,
        );
        if (!t) {
          t = {
            definition: o.trailerDefinition,
            variant: o.trailerVariant,
            unitsCount: o.unitsCount,
            fillRatio: o.fillRatio,
            count: 0,
          };
          cargo.trailers.push(t);
        }
        t.count++;

        if (o.distanceKm > 0) {
          const r = { distanceKm: o.distanceKm, ferryTime: o.ferryTime, ferryPrice: o.ferryPrice };
          this.routes.set(`${c.key}>${o.target}`, { ...r, accuracy: 'exact' });
          const tc = o.target.slice(o.target.indexOf('.') + 1);
          const ck = `${c.city}>${tc}`;
          const prev = this.cityRoutes.get(ck);
          if (!prev || r.distanceKm < prev.distanceKm) this.cityRoutes.set(ck, { ...r, accuracy: 'city' });
        }
      }
    }
    for (const c of this.cargoes.values()) c.trailers.sort((a, b) => b.count - a.count);
  }

  /** 会社キー間の距離をセーブ内の実績から推定 */
  findRoute(sourceKey: string, targetKey: string): RouteInfo | undefined {
    const exact = this.routes.get(`${sourceKey}>${targetKey}`);
    if (exact) return exact;
    const sc = sourceKey.slice(sourceKey.indexOf('.') + 1);
    const tc = targetKey.slice(targetKey.indexOf('.') + 1);
    return this.cityRoutes.get(`${sc}>${tc}`) ?? this.cityRoutes.get(`${tc}>${sc}`);
  }

  getCompanyOffers(companyId: string): JobOffer[] {
    const c = this.companies.get(companyId);
    if (!c) return [];
    return c.offerIds.map((id) => this.offers.get(id)).filter((o): o is JobOffer => !!o);
  }

  /** 仕様のチェック。errors は作成不可、warnings は作成可能だが注意 */
  validate(spec: JobSpec): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const src = this.companies.get(spec.source);
    if (!src) errors.push('出発会社が見つかりません');
    if (!this.companyByKey.has(spec.target)) errors.push('配送先の会社が見つかりません');
    if (src && src.key === spec.target) errors.push('出発地と配送先が同じです');
    if (!/^cargo\.\w+$/.test(spec.cargo)) errors.push('カーゴ ID が不正です (cargo.xxx)');
    if (!/^trailer\.\S+$/.test(spec.trailerVariant)) errors.push('トレーラーバリアントが不正です (trailer.xxx)');
    if (!/^trailer_def\.\S+$/.test(spec.trailerDefinition)) errors.push('トレーラー定義が不正です (trailer_def.xxx)');
    if (!spec.companyTruck || /\s/.test(spec.companyTruck)) errors.push('会社トラックを指定してください');
    if (!(spec.unitsCount >= 1) || !Number.isInteger(spec.unitsCount)) errors.push('積載数は 1 以上の整数にしてください');
    if (!(spec.fillRatio > 0 && spec.fillRatio <= 1)) errors.push('fill_ratio は 0 より大きく 1 以下にしてください');
    if (![0, 1, 2].includes(spec.urgency)) errors.push('緊急度が不正です');
    if (!(spec.distanceKm >= 1) || !Number.isInteger(spec.distanceKm)) errors.push('距離は 1 km 以上の整数にしてください');
    if (!(spec.expirationHours > 0)) errors.push('期限は 0 より大きくしてください');
    if (spec.ferryTime < 0 || spec.ferryPrice < 0) errors.push('フェリー時間・料金は 0 以上にしてください');
    if (src && spec.slot !== 'new' && (spec.slot < 0 || spec.slot >= src.offerIds.length)) {
      errors.push('上書きするスロットが存在しません');
    }

    const cargo = this.cargoes.get(spec.cargo);
    if (src && cargo) {
      if (!cargo.sources.has(src.key)) warnings.push('この会社がこのカーゴを出荷した実績はセーブ内にありません');
      if (!cargo.targets.has(spec.target)) warnings.push('配送先がこのカーゴを受け入れた実績はセーブ内にありません');
      if (!cargo.trailers.some((t) => t.definition === spec.trailerDefinition && t.variant === spec.trailerVariant)) {
        warnings.push('このカーゴとトレーラーの組み合わせはセーブ内に実績がありません');
      }
    } else if (!cargo) {
      warnings.push('このカーゴはセーブ内のオファーに存在しません (DLC 未所持などに注意)');
    }
    return { errors, warnings };
  }

  /** ドキュメントに仕事を書き込む。作成 / 上書きした job_offer_data の ID を返す */
  applyJob(spec: JobSpec): string {
    const { errors } = this.validate(spec);
    if (errors.length) throw new SaveError(errors.join('\n'));
    const company = this.companies.get(spec.source)!;
    const companyUnit = this.units.get(company.id)!;

    const attrs: [string, string][] = [
      ['target', quote(spec.target)],
      ['expiration_time', String(Math.round(this.gameTime + spec.expirationHours * 60))],
      ['urgency', String(spec.urgency)],
      ['shortest_distance_km', String(spec.distanceKm)],
      ['ferry_time', String(Math.round(spec.ferryTime))],
      ['ferry_price', String(Math.round(spec.ferryPrice))],
      ['cargo', spec.cargo],
      ['company_truck', spec.companyTruck],
      ['trailer_variant', spec.trailerVariant],
      ['trailer_definition', spec.trailerDefinition],
      ['units_count', String(spec.unitsCount)],
      ['fill_ratio', String(spec.fillRatio)],
      ['trailer_place', String(spec.trailerPlace ?? 0)],
    ];

    let id: string;
    if (spec.slot === 'new') {
      this.maxNameless += 0x10n;
      id = bigIntToNameless(this.maxNameless);
      while (this.units.has(id)) {
        this.maxNameless += 0x10n;
        id = bigIntToNameless(this.maxNameless);
      }
      const unit: SiiUnit = { type: 'job_offer_data', id, attrs };
      // 既存オファーの直後 (無ければ会社ユニットの直後) に挿入する
      const anchorIds = [company.id, ...company.offerIds];
      let insertAt = -1;
      this.doc.segments.forEach((s, i) => {
        if (s.kind === 'unit' && anchorIds.includes(s.unit.id)) insertAt = Math.max(insertAt, i);
      });
      this.doc.segments.splice(insertAt + 1, 0, { kind: 'text', text: this.doc.eol }, { kind: 'unit', unit });
      this.units.set(id, unit);
      company.offerIds = [...company.offerIds, id];
      setArray(companyUnit, 'job_offer', company.offerIds);
    } else {
      id = company.offerIds[spec.slot];
      const unit = this.units.get(id);
      if (!unit) throw new SaveError(`job_offer_data ${id} が見つかりません`);
      unit.attrs = attrs;
      unit.raw = undefined;
    }
    this.offers.set(id, parseJobOffer(this.units.get(id)!));
    return id;
  }

  serialize(): string {
    return serializeSii(this.doc);
  }
}
