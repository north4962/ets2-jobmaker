import './ui/style.css';
import { detectFormat } from './core/sii';
import { SaveGame, formatGameTime, isEmptyOffer, type JobOffer, type JobSpec } from './core/save';
import { fileIO } from './platform/fileio';

interface Pending {
  uid: number;
  spec: JobSpec;
}

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

const els = {
  fileInfo: $<HTMLDivElement>('fileInfo'),
  openBtn: $<HTMLButtonElement>('openBtn'),
  exportBtn: $<HTMLButtonElement>('exportBtn'),
  dropZone: $<HTMLElement>('dropZone'),
  editor: $<HTMLDivElement>('editor'),
  form: $<HTMLFormElement>('jobForm'),
  source: $('source'),
  discoveredOnly: $('discoveredOnly'),
  slot: $<HTMLSelectElement>('slot'),
  cargo: $('cargo'),
  trailerPreset: $<HTMLSelectElement>('trailerPreset'),
  trailerVariant: $('trailerVariant'),
  trailerDefinition: $('trailerDefinition'),
  unitsCount: $('unitsCount'),
  fillRatio: $('fillRatio'),
  target: $('target'),
  acceptedOnly: $('acceptedOnly'),
  distance: $('distance'),
  ferryTime: $('ferryTime'),
  ferryPrice: $('ferryPrice'),
  routeHint: $<HTMLParagraphElement>('routeHint'),
  urgency: $<HTMLSelectElement>('urgency'),
  expiration: $('expiration'),
  truck: $('truck'),
  messages: $<HTMLUListElement>('messages'),
  resetBtn: $<HTMLButtonElement>('resetBtn'),
  pendingBody: $<HTMLTableSectionElement>('pendingBody'),
  pendingCount: $<HTMLSpanElement>('pendingCount'),
  offersBody: $<HTMLTableSectionElement>('offersBody'),
  companyList: $<HTMLDataListElement>('companyList'),
  targetList: $<HTMLDataListElement>('targetList'),
  cargoList: $<HTMLDataListElement>('cargoList'),
  truckList: $<HTMLDataListElement>('truckList'),
  toast: $<HTMLDivElement>('toast'),
};

let save: SaveGame | null = null;
let originalText = '';
let fileName = 'game.sii';
let pending: Pending[] = [];
let uidSeq = 1;

const URGENCY = ['標準', '重要', '緊急'];

// ---- 汎用 -----------------------------------------------------------------

function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  els.toast.textContent = msg;
  els.toast.className = `toast ${kind}`;
  els.toast.hidden = false;
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => (els.toast.hidden = true), 4000);
}

function fillDatalist(list: HTMLDataListElement, items: { value: string; label?: string }[]) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    if (it.label) o.label = it.label;
    frag.append(o);
  }
  list.replaceChildren(frag);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

const short = (id: string | null, prefix: string) => (id ? id.replace(prefix, '') : '—');
const sourceId = () => (save?.companyByKey.get(els.source.value.trim()) ?? '');

// ---- 読み込み -------------------------------------------------------------

async function loadBytes(name: string, bytes: Uint8Array) {
  const fmt = detectFormat(bytes);
  if (fmt === 'encrypted' || fmt === 'binary') {
    toast(
      fmt === 'encrypted'
        ? 'このファイルは暗号化されています。SII_Decrypt などで復号化してから読み込んでください。'
        : 'バイナリ形式 (BSII) です。テキスト形式に復号化してから読み込んでください。',
      'error',
    );
    return;
  }
  try {
    const text = new TextDecoder('utf-8').decode(bytes);
    const s = SaveGame.fromText(text);
    save = s;
    originalText = text;
    fileName = name;
    pending = [];
    onSaveLoaded();
    toast(`${name} を読み込みました`);
  } catch (e) {
    toast(`読み込みに失敗しました: ${(e as Error).message}`, 'error');
  }
}

function onSaveLoaded() {
  if (!save) return;
  const offers = [...save.offers.values()].filter((o) => !isEmptyOffer(o)).length;
  els.fileInfo.textContent =
    `${fileName} ／ ${formatGameTime(save.gameTime)} ／ 会社 ${save.companies.size} ／ ` +
    `オファー ${offers} ／ カーゴ ${save.cargoes.size}`;
  els.dropZone.hidden = true;
  els.editor.hidden = false;
  els.exportBtn.disabled = false;

  fillDatalist(
    els.cargoList,
    [...save.cargoes.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({ value: c.id, label: `${c.count} 件の実績` })),
  );
  fillDatalist(
    els.truckList,
    [...save.trucks].sort((a, b) => b[1] - a[1]).map(([t]) => ({ value: t })),
  );
  refreshCompanyList();
  resetForm();
  renderPending();
}

// ---- フォーム ---------------------------------------------------------------

function refreshCompanyList() {
  if (!save) return;
  const only = els.discoveredOnly.checked;
  fillDatalist(
    els.companyList,
    [...save.companies.values()]
      .filter((c) => !only || c.discovered)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((c) => ({ value: c.key, label: `${c.city} / ${c.name}` })),
  );
}

function refreshTargetList() {
  if (!save) return;
  const cargo = save.cargoes.get(els.cargo.value.trim());
  const src = els.source.value.trim();
  const keys =
    els.acceptedOnly.checked && cargo ? [...cargo.targets] : [...save.companyByKey.keys()];
  fillDatalist(
    els.targetList,
    keys
      .filter((k) => k !== src)
      .sort()
      .map((k) => {
        const r = save!.findRoute(src, k);
        return { value: k, label: r ? `約 ${r.distanceKm} km` : undefined };
      }),
  );
}

function refreshSlots(keepSelection = true) {
  const id = sourceId();
  const prev = els.slot.value;
  els.slot.replaceChildren();
  els.slot.append(new Option('新規オファーとして追加', 'new'));
  if (save && id) {
    const used = new Set(pending.filter((p) => p.spec.source === id).map((p) => String(p.spec.slot)));
    save.getCompanyOffers(id).forEach((o, i) => {
      const desc = isEmptyOffer(o)
        ? '空きスロット'
        : `上書き: ${short(o.cargo, 'cargo.')} → ${o.target}`;
      const opt = new Option(`#${i} ${desc}${used.has(String(i)) ? ' (作成リストで使用中)' : ''}`, String(i));
      opt.disabled = used.has(String(i));
      els.slot.append(opt);
    });
  }
  if (keepSelection && [...els.slot.options].some((o) => o.value === prev && !o.disabled)) els.slot.value = prev;
  else {
    // 空きスロットがあれば優先的に使う
    const empty = save && id ? save.getCompanyOffers(id).findIndex((o, i) => isEmptyOffer(o) && !els.slot.options[i + 1]?.disabled) : -1;
    els.slot.value = empty >= 0 ? String(empty) : 'new';
  }
}

function refreshTrailerPresets() {
  els.trailerPreset.replaceChildren();
  const cargo = save?.cargoes.get(els.cargo.value.trim());
  if (!cargo) {
    els.trailerPreset.append(new Option('(実績なし: 下の欄に直接入力)', ''));
    return;
  }
  cargo.trailers.forEach((t, i) => {
    els.trailerPreset.append(
      new Option(
        `${short(t.definition, 'trailer_def.')} / ${short(t.variant, 'trailer.')} ×${t.unitsCount}` +
          (t.fillRatio !== 1 ? ` (fill ${t.fillRatio})` : '') + ` — ${t.count} 件`,
        String(i),
      ),
    );
  });
  els.trailerPreset.append(new Option('カスタム (直接入力)', ''));
  applyTrailerPreset();
}

function applyTrailerPreset() {
  const cargo = save?.cargoes.get(els.cargo.value.trim());
  const t = cargo?.trailers[Number(els.trailerPreset.value)];
  if (!t || els.trailerPreset.value === '') return;
  els.trailerVariant.value = t.variant;
  els.trailerDefinition.value = t.definition;
  els.unitsCount.value = String(t.unitsCount);
  els.fillRatio.value = String(t.fillRatio);
}

function refreshRoute(force = false) {
  if (!save) return;
  const src = els.source.value.trim();
  const tgt = els.target.value.trim();
  const r = src && tgt ? save.findRoute(src, tgt) : undefined;
  if (!r) {
    els.routeHint.textContent = src && tgt ? 'セーブ内に同じ区間の実績がないため、距離は手入力してください。' : '';
    return;
  }
  els.routeHint.textContent =
    (r.accuracy === 'exact' ? '同じ会社間の実績' : '同じ都市間の実績') +
    `: ${r.distanceKm} km` + (r.ferryTime ? ` / フェリー ${r.ferryTime} 分・${r.ferryPrice}` : '');
  if (force || !els.distance.value) {
    els.distance.value = String(r.distanceKm);
    els.ferryTime.value = String(r.ferryTime);
    els.ferryPrice.value = String(r.ferryPrice);
  }
}

function readSpec(): JobSpec {
  const slot = els.slot.value === 'new' ? 'new' : Number(els.slot.value);
  return {
    source: sourceId(),
    slot,
    target: els.target.value.trim(),
    cargo: els.cargo.value.trim(),
    trailerVariant: els.trailerVariant.value.trim(),
    trailerDefinition: els.trailerDefinition.value.trim(),
    unitsCount: Number(els.unitsCount.value),
    fillRatio: Number(els.fillRatio.value),
    urgency: Number(els.urgency.value) as 0 | 1 | 2,
    distanceKm: Number(els.distance.value),
    ferryTime: Number(els.ferryTime.value || 0),
    ferryPrice: Number(els.ferryPrice.value || 0),
    expirationHours: Number(els.expiration.value),
    companyTruck: els.truck.value.trim(),
  };
}

function validateForm(show = true): JobSpec | null {
  if (!save) return null;
  const spec = readSpec();
  const { errors, warnings } = save.validate(spec);
  if (show) {
    els.messages.replaceChildren(
      ...errors.map((m) => el('li', m, 'error')),
      ...warnings.map((m) => el('li', m, 'warn')),
    );
  }
  return errors.length ? null : spec;
}

function resetForm() {
  els.form.reset();
  els.discoveredOnly.checked = true;
  els.acceptedOnly.checked = true;
  els.fillRatio.value = '1';
  els.ferryTime.value = '0';
  els.ferryPrice.value = '0';
  els.expiration.value = '72';
  els.truck.value = save ? ([...save.trucks].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '') : '';
  els.messages.replaceChildren();
  els.routeHint.textContent = '';
  refreshSlots();
  refreshTrailerPresets();
  refreshTargetList();
  renderOffers();
}

/** 既存オファーの内容をフォームに読み込む (参考にして作成) */
function copyOffer(o: JobOffer) {
  if (!o.cargo) return;
  els.cargo.value = o.cargo;
  refreshTrailerPresets();
  const idx = save?.cargoes.get(o.cargo)?.trailers.findIndex(
    (t) => t.variant === o.trailerVariant && t.definition === o.trailerDefinition && t.unitsCount === o.unitsCount,
  );
  els.trailerPreset.value = idx !== undefined && idx >= 0 ? String(idx) : '';
  els.trailerVariant.value = o.trailerVariant ?? '';
  els.trailerDefinition.value = o.trailerDefinition;
  els.unitsCount.value = String(o.unitsCount);
  els.fillRatio.value = String(o.fillRatio);
  els.target.value = o.target;
  els.distance.value = String(o.distanceKm);
  els.ferryTime.value = String(o.ferryTime);
  els.ferryPrice.value = String(o.ferryPrice);
  els.urgency.value = String(o.urgency ?? 0);
  els.truck.value = o.companyTruck;
  refreshTargetList();
  refreshRoute();
  validateForm();
}

// ---- 表示 -----------------------------------------------------------------

function renderOffers() {
  els.offersBody.replaceChildren();
  const id = sourceId();
  if (!save || !id) {
    const tr = el('tr');
    const td = el('td', '出発会社を選択すると表示されます', 'empty');
    td.colSpan = 6;
    tr.append(td);
    els.offersBody.append(tr);
    return;
  }
  save.getCompanyOffers(id).forEach((o, i) => {
    const tr = el('tr');
    const empty = isEmptyOffer(o);
    const left =
      o.expirationTime !== null ? Math.round((o.expirationTime - save!.gameTime) / 60) : null;
    tr.append(
      el('td', String(i)),
      el('td', empty ? '(空き)' : o.target),
      el('td', empty ? '' : short(o.cargo, 'cargo.')),
      el('td', empty ? '' : String(o.distanceKm)),
      el('td', left === null ? '' : left >= 0 ? `${left} 時間` : '期限切れ'),
    );
    const td = el('td');
    if (!empty) {
      const b = el('button', '参考にする', 'small');
      b.type = 'button';
      b.onclick = () => copyOffer(o);
      td.append(b);
    }
    tr.append(td);
    els.offersBody.append(tr);
  });
  if (!els.offersBody.children.length) {
    const tr = el('tr');
    const td = el('td', 'オファーはありません (新規追加になります)', 'empty');
    td.colSpan = 6;
    tr.append(td);
    els.offersBody.append(tr);
  }
}

function renderPending() {
  els.pendingCount.textContent = String(pending.length);
  els.exportBtn.textContent = pending.length ? `保存 (書き出し: ${pending.length} 件)` : '保存 (書き出し)';
  els.pendingBody.replaceChildren();
  if (!pending.length) {
    const tr = el('tr');
    const td = el('td', 'まだ仕事はありません', 'empty');
    td.colSpan = 6;
    tr.append(td);
    els.pendingBody.append(tr);
    return;
  }
  for (const p of pending) {
    const s = p.spec;
    const tr = el('tr');
    tr.title = `${s.trailerDefinition} / ${s.trailerVariant} ×${s.unitsCount} / ${URGENCY[s.urgency]} / 期限 ${s.expirationHours} 時間 / ${s.companyTruck}`;
    const del = el('button', '削除', 'small danger');
    del.type = 'button';
    del.onclick = () => {
      pending = pending.filter((x) => x.uid !== p.uid);
      renderPending();
      refreshSlots();
    };
    const td = el('td');
    td.append(del);
    tr.append(
      el('td', s.source.replace('company.volatile.', '')),
      el('td', s.target),
      el('td', short(s.cargo, 'cargo.')),
      el('td', String(s.distanceKm)),
      el('td', s.slot === 'new' ? '新規' : `#${s.slot}`),
      td,
    );
    els.pendingBody.append(tr);
  }
}

// ---- 書き出し ---------------------------------------------------------------

async function exportSave() {
  if (!save) return;
  if (!pending.length && !confirm('作成リストが空です。変更なしで書き出しますか？')) return;
  try {
    // 元テキストから作り直して全件適用する (作成リストの削除をそのまま反映できる)
    const out = SaveGame.fromText(originalText);
    for (const p of pending) out.applyJob(p.spec);
    const ok = await fileIO.save(fileName.endsWith('.sii') ? fileName : 'game.sii', out.serialize());
    if (ok) toast(`${pending.length} 件の仕事を書き込んで保存しました`);
  } catch (e) {
    toast(`書き出しに失敗しました: ${(e as Error).message}`, 'error');
  }
}

// ---- イベント -------------------------------------------------------------

els.openBtn.onclick = async () => {
  if (pending.length && !confirm('作成リストは破棄されます。別のファイルを開きますか？')) return;
  const f = await fileIO.open();
  if (f) await loadBytes(f.name, f.bytes);
};
els.exportBtn.onclick = exportSave;

for (const t of [document.body]) {
  t.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('over');
  });
  t.addEventListener('dragleave', () => els.dropZone.classList.remove('over'));
  t.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('over');
    const f = e.dataTransfer?.files[0];
    if (f) await loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
  });
}

els.discoveredOnly.onchange = refreshCompanyList;
els.acceptedOnly.onchange = refreshTargetList;
els.source.addEventListener('change', () => {
  refreshSlots(false);
  refreshTargetList();
  renderOffers();
  refreshRoute(true);
  validateForm();
});
els.slot.onchange = () => {
  const id = sourceId();
  const o = save && id && els.slot.value !== 'new' ? save.getCompanyOffers(id)[Number(els.slot.value)] : undefined;
  if (o?.companyTruck) els.truck.value = o.companyTruck;
  validateForm();
};
els.cargo.addEventListener('change', () => {
  refreshTrailerPresets();
  refreshTargetList();
  validateForm();
});
els.trailerPreset.onchange = () => {
  applyTrailerPreset();
  validateForm();
};
els.target.addEventListener('change', () => {
  refreshRoute(true);
  validateForm();
});
els.form.addEventListener('input', () => validateForm());
els.resetBtn.onclick = resetForm;

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const spec = validateForm();
  if (!spec) {
    toast('入力内容にエラーがあります', 'error');
    return;
  }
  pending.push({ uid: uidSeq++, spec });
  renderPending();
  refreshSlots(false);
  validateForm();
  toast(`作成リストに追加しました: ${spec.cargo.replace('cargo.', '')} → ${spec.target}`);
});

window.addEventListener('beforeunload', (e) => {
  if (pending.length) e.preventDefault();
});

renderPending();
