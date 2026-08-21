/**
 * Кастом-виджеты полей 3D-ассетов для конфиг-редактора (вкладки Меши/Текстуры/Материалы):
 *  - ЦВЕТ (baseColor/emissive): tuple [r,g,b] 0..1 ↔ <input type=color> + хекс-поле;
 *  - URL (текстура/меш): текст-поле + кнопка загрузки файла на сервер (`POST /api/dev/assets/<id>`
 *    → `{ url }`; расширение из типа файла) — сразу пишет полученный url в поле.
 * Регистрируются в `main.ts` через `fieldCustomRenderers` по имени поля. Аплоад — DEV-only (в проде 403).
 */

import { createMaterialPreview, type MaterialPreview, type MatCfg, type TexCfg } from './materialPreview.js';

let activeMatPreview: MaterialPreview | undefined;   // одна превью-сфера за раз (гасим прошлый WebGL-контекст при пересборке панели)

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const to255 = (n: number): number => Math.round(clamp01(n) * 255);
const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
function rgbToHex(rgb: unknown): string {
  const a = Array.isArray(rgb) ? (rgb as number[]) : [0, 0, 0];
  return '#' + hex2(to255(a[0] ?? 0)) + hex2(to255(a[1] ?? 0)) + hex2(to255(a[2] ?? 0));
}
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const inputCss = 'box-sizing:border-box;padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

/** Пикер цвета для tuple [r,g,b] 0..1 (baseColor/emissive материала). Палитра + хекс синхронны. */
export function renderColorField(value: unknown, onChange: (v: unknown) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;align-items:center';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = rgbToHex(value);
  picker.style.cssText = 'width:44px;height:28px;padding:0;border:1px solid #2c2c3a;border-radius:4px;background:#0f0f16;cursor:pointer';
  const txt = document.createElement('input');
  txt.type = 'text';
  txt.value = rgbToHex(value);
  txt.style.cssText = inputCss + ';flex:1';
  const sync = (hex: string): void => {
    const rgb = hexToRgb(hex);
    picker.value = rgbToHex(rgb); txt.value = rgbToHex(rgb);
    onChange(rgb);
  };
  picker.addEventListener('input', () => sync(picker.value));
  txt.addEventListener('change', () => sync(txt.value));
  wrap.append(picker, txt);
  return wrap;
}

const CONTENT_TYPE: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  glb: 'model/gltf-binary', gltf: 'model/gltf-binary',
};

/** Залить бинарь на сервер под `id` → `{ url }`. contentType задаёт расширение файла на диске. `strip` (GLB) — сервер
 *  вырежет вшитые текстуры, оставив геометрию+развёртку. `dir` — подпапка в /assets (раскладка по тайл-сетам). */
export interface MeshColliderCfg { shape: 'circle' | 'box'; r?: number; w?: number; h?: number }
async function uploadAsset(id: string, data: ArrayBuffer, contentType: string, strip = false, dir = ''): Promise<{ url: string; bytes?: number; note?: string; collider?: MeshColliderCfg }> {
  const q = new URLSearchParams();
  if (strip) q.set('strip', '1');
  if (dir) q.set('dir', dir);
  const qs = q.toString();
  const r = await fetch('/api/dev/assets/' + encodeURIComponent(id) + (qs ? '?' + qs : ''), {
    method: 'POST', headers: { 'content-type': contentType }, body: data,
  });
  if (!r.ok) throw new Error('upload ' + r.status);
  return r.json() as Promise<{ url: string; bytes?: number; note?: string; collider?: MeshColliderCfg }>;
}

// ── Раскладка ассетов по папкам ПО КАТЕГОРИИ (персонаж/монстр/тайл/декор/оружие) + набор (для тайлов/декора).
//    Общее состояние (категория + набор), помнится в localStorage. Определяет подпапку аплоада (см. folderForCategory).
export type AssetCategory = 'character' | 'monster' | 'tile' | 'decor' | 'weapon' | 'misc';
const CAT_LABEL: Record<AssetCategory, string> = { character: '🧍 Персонаж', monster: '👹 Монстр', tile: '🧱 Тайл', decor: '🏺 Декор', weapon: '⚔ Оружие', misc: '📦 Прочее' };
const CAT_ORDER: AssetCategory[] = ['tile', 'decor', 'character', 'monster', 'weapon', 'misc'];
let assetCategory: AssetCategory = (() => { try { return (localStorage.getItem('dm_asset_cat') as AssetCategory) || 'tile'; } catch { return 'tile'; } })();
let assetBaseDir = (() => { try { return localStorage.getItem('dm_asset_dir') ?? 'crypt'; } catch { return 'crypt'; } })();
const IMG_EXT = /^(png|jpe?g|webp)$/i;

/** Текущая выбранная категория (для makeEntry моделей — проставить model.category + kind). */
export function currentAssetCategory(): AssetCategory { return assetCategory; }

/** Папка категории. Тайл/декор группируются по набору (<кат>/<набор>); персонаж/монстр/оружие — просто по категории. */
function folderForCategory(cat: AssetCategory): string {
  const set = assetBaseDir.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  switch (cat) {
    case 'character': return 'characters';
    case 'monster': return 'monsters';
    case 'weapon': return 'weapons';
    case 'tile': return set ? `tiles/${set}` : 'tiles';
    case 'decor': return set ? `decor/${set}` : 'decor';
    default: return set || 'misc';
  }
}
/** Подпапка для файла: картинки → <папка категории>/textures, меши → <папка категории>. */
function assetDirFor(ext: string): string {
  const base = folderForCategory(assetCategory);
  return IMG_EXT.test(ext) ? base + '/textures' : base;
}
/** Контрол «категория + набор» — общий для виджетов загрузки: задаёт подпапку, категорию модели и (для тайлов) набор. */
function renderFolderField(): HTMLElement {
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;gap:5px;align-items:center;font-size:11px;color:#9aa;white-space:nowrap';
  const sel = document.createElement('select'); sel.style.cssText = inputCss + ';width:112px';
  for (const c of CAT_ORDER) { const o = document.createElement('option'); o.value = c; o.textContent = CAT_LABEL[c]; sel.appendChild(o); }
  sel.value = assetCategory; sel.title = 'Категория загружаемых моделей: задаёт папку, группу в дереве и набор полей (тайл ≠ персонаж).';
  const setWrap = document.createElement('label'); setWrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center'; setWrap.title = 'Набор (для тайлов/декора): подпапка tiles/<набор>. Для персонажа/монстра/оружия не нужен.';
  const setLbl = document.createElement('span'); setLbl.textContent = '📁';
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = assetBaseDir; inp.placeholder = 'crypt'; inp.style.cssText = inputCss + ';width:80px;min-width:56px';
  const hint = document.createElement('span'); hint.style.cssText = 'color:#667';
  const updateHint = (): void => { hint.textContent = '→ ' + folderForCategory(assetCategory) + '/'; setWrap.style.display = (assetCategory === 'tile' || assetCategory === 'decor') ? 'inline-flex' : 'none'; };
  sel.addEventListener('change', () => { assetCategory = sel.value as AssetCategory; try { localStorage.setItem('dm_asset_cat', assetCategory); } catch { /* ignore */ } updateHint(); });
  inp.addEventListener('input', () => { assetBaseDir = inp.value; try { localStorage.setItem('dm_asset_dir', inp.value); } catch { /* ignore */ } updateHint(); });
  setWrap.append(setLbl, inp);
  wrap.append(sel, setWrap, hint); updateHint();
  return wrap;
}

/** Чекбокс «🪶 срезать вшитые текстуры (GLB → только геометрия)» — общий для полей загрузки. Дефолт ВКЛ: экспортируй с
 *  текстурами (UV не слетает), сервер срежет картинки, материал в игре — из конфига. Сними для атласа персонажа, если
 *  его сабмешам не назначены материалы конфига (тогда нужен вшитый). PNG/текстуры игнорируют (стрип только для .glb). */
function stripCheckbox(): { el: HTMLElement; on: () => boolean } {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;cursor:pointer;font-size:11px;color:#9aa;white-space:nowrap';
  wrap.title = 'Только для GLB: вырезать вшитые текстуры, оставив геометрию+развёртку. Экспортируй модель С текстурами (иначе экспортёр роняет UV) — сервер срежет картинки сам. Материал в игре берётся из конфига. Сними, если это атлас персонажа без назначенных материалов конфига.';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
  const t = document.createElement('span'); t.textContent = '🪶 срезать текстуры GLB';
  wrap.append(cb, t);
  return { el: wrap, on: () => cb.checked };
}
/** Чекбокс flipY для загрузки текстур. Персонаж-атласы (Max/FBX) несут UV в конвенции V-вверх → их текстурам нужен flipY=true
 *  (иначе кладутся кверх ногами). Окружение (тайлы/стриппер) — glTF V-вниз, flipY=false. Дефолт ВКЛ (грузим персонажей); сними для окружения. */
function flipYCheckbox(): { el: HTMLElement; on: () => boolean } {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;cursor:pointer;font-size:11px;color:#9aa;white-space:nowrap';
  wrap.title = 'flipY: перевернуть текстуру по вертикали. ВКЛ для текстур ПЕРСОНАЖЕЙ (Max/FBX — их UV V-вверх, иначе кверх ногами). Сними для ОКРУЖЕНИЯ (тайлы/стриппер — glTF V-вниз).';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
  const t = document.createElement('span'); t.textContent = '🔄 flipY (перс.)';
  wrap.append(cb, t);
  return { el: wrap, on: () => cb.checked };
}

/** Текст-поле url + кнопка загрузки файла (PNG/JPG/WEBP/GLB) на сервер → url ассета. Имя ассета на диске = `parent.id`
 *  (по умолчанию), либо имя выбранного файла при `idFromFilename` (нужно, когда у записи НЕСКОЛЬКО url-полей — пол+стена
 *  окружения — чтобы они не перезаписывали друг друга под одним parent.id). */
export function renderUploadField(value: unknown, onChange: (v: unknown) => void, parent: Record<string, unknown> | undefined, idFromFilename = false): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  const txt = document.createElement('input');
  txt.type = 'text';
  txt.value = value == null ? '' : String(value);
  txt.placeholder = '/assets/<id>.<ext>';
  txt.style.cssText = inputCss + ';flex:1;min-width:160px';
  txt.addEventListener('input', () => onChange(txt.value));
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.png,.jpg,.jpeg,.webp,.glb,.gltf';
  file.style.display = 'none';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '⬆ Загрузить';
  btn.style.cssText = 'padding:5px 8px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px;font-size:12px;white-space:nowrap';
  const status = document.createElement('span');
  status.style.cssText = 'font-size:11px;color:#9aa';
  const strip = stripCheckbox();
  btn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop() ?? 'bin';
    const nameId = f.name.replace(/\.[^.]+$/, '');   // имя файла без расширения
    const id = String((idFromFilename ? nameId : (parent?.id as string) || nameId)).replace(/[^a-zA-Z0-9_-]/g, '') || 'asset';
    const doStrip = ext === 'glb' && strip.on();
    const dir = assetDirFor(ext);
    status.textContent = 'загрузка…'; status.style.color = '#ffb020';
    f.arrayBuffer()
      .then((buf) => uploadAsset(id, buf, CONTENT_TYPE[ext] ?? 'application/octet-stream', doStrip, dir))
      .then((res) => {
        // Коллайдер из меша `collider*` GLB → сохраняем в модель (источник для objects.collider). Только если сервер извлёк.
        if (res.collider && parent) (parent as Record<string, unknown>).collider = res.collider;
        txt.value = res.url; onChange(res.url);
        const cn = res.collider ? ' · коллайдер ' + (res.collider.shape === 'circle' ? `⌀${(res.collider.r ?? 0).toFixed(2)}` : `▭${(res.collider.w ?? 0).toFixed(2)}×${(res.collider.h ?? 0).toFixed(2)}`) : '';
        status.textContent = 'ок · ' + res.url.replace('/assets/', '') + (res.note ? ' · ' + res.note : '') + cn; status.style.color = '#7fd67f';
      })
      .catch((e: Error) => { status.textContent = 'ошибка: ' + e.message; status.style.color = '#ff6b6b'; });
  });
  wrap.append(txt, btn, file, strip.el, status);   // папку задаём в пакетной загрузке (общая), тут — только стрип
  return wrap;
}

/** Кнопка ПАКЕТНОЙ загрузки: мультивыбор файлов → upload каждого → `makeEntry(id,url,filename)` пушится в `arr` → `onDone`.
 *  id ассета = имя файла без расширения (уникальность между несколькими файлами). Для вкладок Текстуры/3D. */
export function renderBatchUpload(accept: string, arr: Record<string, unknown>[], makeEntry: (id: string, url: string, filename: string, flipY?: boolean) => Record<string, unknown>, onDone: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:100%';
  const file = document.createElement('input');
  file.type = 'file'; file.accept = accept; file.multiple = true; file.style.display = 'none';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = '⬆ Загрузить несколько';
  btn.style.cssText = 'padding:5px 8px;cursor:pointer;background:#26406a;color:#e8e8f0;border:1px solid #3c5a8a;border-radius:4px;font-size:12px;white-space:nowrap';
  const status = document.createElement('span'); status.style.cssText = 'font-size:11px;color:#9aa';
  const strip = stripCheckbox();
  const showStrip = /glb|gltf/i.test(accept);   // чекбокс стрипа только там, где грузят меши
  const flip = flipYCheckbox();
  const showFlip = /png|jpe?g|webp/i.test(accept);   // чекбокс flipY только для картинок
  btn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const files = [...(file.files ?? [])];
    if (!files.length) return;
    let done = 0, ok = 0;
    status.textContent = `0/${files.length}…`; status.style.color = '#ffb020';
    for (const f of files) {
      const ext = f.name.toLowerCase().split('.').pop() ?? 'bin';
      const id = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'asset';
      const doStrip = ext === 'glb' && showStrip && strip.on();
      const dir = assetDirFor(ext);
      f.arrayBuffer()
        .then((buf) => uploadAsset(id, buf, CONTENT_TYPE[ext] ?? 'application/octet-stream', doStrip, dir))
        .then((res) => { arr.push(makeEntry(id, res.url, f.name.replace(/\.[^.]+$/, ''), flip.on())); ok++; })
        .catch(() => { /* пропускаем битый файл */ })
        .finally(() => { done++; status.textContent = `${done}/${files.length}`; if (done === files.length) { status.textContent = `готово: ${ok}/${files.length}`; status.style.color = '#7fd67f'; onDone(); } });
    }
    file.value = '';
  });
  wrap.append(btn, file, renderFolderField(), ...(showStrip ? [strip.el] : []), ...(showFlip ? [flip.el] : []), status);
  return wrap;
}

// ── Unity-подобная панель материала (Base/Metallic+Smoothness/Normal/Emission/Occlusion) ────────────────
const matSecCss = 'border:1px solid #2c2c3a;border-radius:6px;padding:8px 10px;margin:8px 0;background:#12121a';
const matRowCss = 'display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;margin:4px 0';
function matSection(title: string): HTMLElement { const d = document.createElement('div'); d.style.cssText = matSecCss; const t = document.createElement('div'); t.textContent = title; t.style.cssText = 'font-size:12px;font-weight:600;color:#c8cbe0;margin-bottom:4px'; d.appendChild(t); return d; }
function matRow(parent: HTMLElement, label: string, control: HTMLElement): void { const d = document.createElement('div'); d.style.cssText = matRowCss; const l = document.createElement('span'); l.textContent = label; l.style.cssText = 'color:#9aa;font-size:12px'; d.append(l, control); parent.appendChild(d); }
/** Выпадашка текстуры (id из вкладки «Текстуры»; '' = без карты). */
function texSelect(ids: string[], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = document.createElement('select'); sel.style.cssText = inputCss + ';width:100%';
  for (const id of (ids.includes('') ? ids : ['', ...ids])) { const o = document.createElement('option'); o.value = id; o.textContent = id || '— нет —'; sel.appendChild(o); }
  sel.value = value; sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
/** Ползунок 0..max + числовое поле (синхронны). */
function matSlider(value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:8px;align-items:center';
  const r = document.createElement('input'); r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(value); r.style.flex = '1';
  const n = document.createElement('input'); n.type = 'number'; n.min = String(min); n.max = String(max); n.step = String(step); n.value = String(value); n.style.cssText = inputCss + ';width:64px';
  r.addEventListener('input', () => { n.value = r.value; onChange(parseFloat(r.value)); });
  n.addEventListener('change', () => { r.value = n.value; onChange(parseFloat(n.value)); });
  wrap.append(r, n); return wrap;
}
/** Чекбокс + подпись «вкл» (булевы поля материала). */
function matCheck(value: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const wrap = document.createElement('label'); wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;cursor:pointer'; if (title) wrap.title = title;
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = value;
  const t = document.createElement('span'); t.textContent = value ? 'вкл' : ''; t.style.cssText = 'font-size:11px;color:#9aa';
  cb.addEventListener('change', () => { t.textContent = cb.checked ? 'вкл' : ''; onChange(cb.checked); });
  wrap.append(cb, t); return wrap;
}

/** Панель материала (аналог Surface Inputs в Unity URP) + живая ПРЕВЬЮ-СФЕРА нашим рендером (Three.js). Smoothness =
 *  1 − roughness. Мутирует `mat` на месте; параметры видны на сфере в реальном времени (без ре-рендера страницы).
 *  onChange зовём лишь на смену id/name (обновить подпись в списке). texData — все текстуры (для превью и «Fix»). */
export function renderMaterialPanel(mat: Record<string, unknown>, textureIds: () => string[], texData: () => Record<string, unknown>[], onChange: (v: Record<string, unknown>) => void): HTMLElement {
  const m = mat;
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  activeMatPreview?.dispose();
  const preview = createMaterialPreview(240);
  activeMatPreview = preview;
  const live = (): void => preview.update(m as MatCfg, texData() as unknown as TexCfg[]);   // применить материал на сфере (реалтайм)
  const setTex = (key: string, v: string): void => { if (v) m[key] = v; else delete m[key]; live(); };

  const box = document.createElement('div');
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap';
  const left = document.createElement('div'); left.style.cssText = 'flex:0 0 auto';
  left.appendChild(preview.el);
  const hint = document.createElement('div'); hint.textContent = 'тащи мышью — вращать · свет как в подземелье · параметры видны сразу'; hint.style.cssText = 'font-size:10px;color:#667;margin-top:5px;max-width:240px';
  left.appendChild(hint);
  // Слайдер силы окружения (IBL): 0 = как в игре (только факел, тускло); выше — подсветить металл для авторинга.
  const envRow = document.createElement('div'); envRow.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center';
  const envLbl = document.createElement('span'); envLbl.textContent = 'Окружение'; envLbl.title = 'Вклад отражений окружения (IBL). 0 = как в игре (тускло); выше — подсветить металл при авторинге.'; envLbl.style.cssText = 'font-size:11px;color:#9aa;min-width:72px';
  envRow.append(envLbl, matSlider(0, 0, 2, 0.05, (v) => preview.setEnv(v)));   // 0 = вид игры (без IBL); подними для авторинга металла
  left.appendChild(envRow);
  const right = document.createElement('div'); right.style.cssText = 'flex:1;min-width:300px';
  row.append(left, right); box.appendChild(row);

  const head = document.createElement('div'); head.style.cssText = 'display:flex;gap:8px;margin-bottom:6px';
  for (const [key, ph] of [['id', 'id'], ['name', 'имя']] as [string, string][]) {
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = ph; inp.value = str(m[key]); inp.style.cssText = inputCss + ';flex:1';
    inp.addEventListener('input', () => { m[key] = inp.value; });               // мутация на месте (фокус не теряем)
    inp.addEventListener('change', () => onChange(m));                          // на blur — обновить подпись в списке
    head.appendChild(inp);
  }
  right.appendChild(head);

  const base = matSection('Base Map');
  matRow(base, 'Текстура', texSelect(textureIds(), str(m.map), (v) => setTex('map', v)));
  matRow(base, 'Цвет (tint)', renderColorField(m.baseColor ?? [1, 1, 1], (v) => { m.baseColor = v; live(); }));
  matRow(base, 'Прозрачность', matSlider(num(m.opacity, 1), 0, 1, 0.01, (v) => { m.opacity = v; live(); }));
  right.appendChild(base);

  const met = matSection('Metallic Map');
  matRow(met, 'Текстура', texSelect(textureIds(), str(m.metalnessMap), (v) => setTex('metalnessMap', v)));
  matRow(met, 'Metallic', matSlider(num(m.metalness, 0), 0, 1, 0.01, (v) => { m.metalness = v; live(); }));
  matRow(met, 'Metallic ±сдвиг', matSlider(num(m.metalnessOffset, 0), -1, 1, 0.02, (v) => { m.metalnessOffset = v; live(); }));   // поверх карты: + металличнее, − нет
  matRow(met, 'Smoothness', matSlider(1 - num(m.roughness, 0.8), 0, 1, 0.01, (v) => { m.roughness = +(1 - v).toFixed(3); live(); }));   // Unity: 1 − roughness (множитель карты)
  matRow(met, 'Roughness ±сдвиг', matSlider(num(m.roughnessOffset, 0), -1, 1, 0.02, (v) => { m.roughnessOffset = v; live(); }));   // ПОВЕРХ карты: + матовее (гасит глянец швов), − глянцевее
  matRow(met, 'Roughness Map', texSelect(textureIds(), str(m.roughnessMap), (v) => setTex('roughnessMap', v)));
  matRow(met, '🔄 Инверт. карту', matCheck(!!m.roughnessIsSmoothness, (v) => { m.roughnessIsSmoothness = v; live(); }, 'ИНВЕРТИРОВАТЬ карту шероховатости (1−value). Включи, если глянец и матовость перепутаны местами (карта — Smoothness из Unity: ярче=глаже).'));
  right.appendChild(met);

  const nrm = matSection('Normal Map');
  matRow(nrm, 'Текстура', texSelect(textureIds(), str(m.normalMap), (v) => setTex('normalMap', v)));
  matRow(nrm, 'Сила', matSlider(num(m.normalScale, 1), 0, 2, 0.05, (v) => { m.normalScale = v; live(); }));
  matRow(nrm, 'Flip Green', matCheck(!!m.normalFlipY, (v) => { m.normalFlipY = v; live(); }, 'Инвертировать зелёный канал: 3ds Max/DirectX (Y−) → OpenGL/glTF (Y+). Если выпуклости выглядят как вмятины — включи.'));
  // «Fix» = пометить нормал-текстуру linear (наклон — данные, не цвет). Аналог кнопки «Fix Now» у нормалмапы в Unity.
  const fix = document.createElement('button'); fix.type = 'button'; fix.textContent = '🛠 Fix нормалмап';
  fix.title = 'Пометить нормал-текстуру как linear (данные наклона, не sRGB-цвет). Аналог «Fix Now» в Unity.';
  fix.style.cssText = 'padding:4px 8px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px;font-size:12px';
  const fixNote = document.createElement('span'); fixNote.style.cssText = 'font-size:11px;color:#9aa;margin-left:8px';
  fix.addEventListener('click', () => {
    const id = str(m.normalMap);
    if (!id) { fixNote.textContent = 'нет нормал-текстуры'; fixNote.style.color = '#ff9b9b'; return; }
    const t = texData().find((x) => x.id === id);
    if (t) { t.colorSpace = 'linear'; live(); fixNote.textContent = `ок: ${id} → linear`; fixNote.style.color = '#7fd67f'; }
    else { fixNote.textContent = 'текстура не найдена в конфиге'; fixNote.style.color = '#ff9b9b'; }
  });
  const fixRow = document.createElement('div'); fixRow.style.cssText = matRowCss;
  const fixLbl = document.createElement('span'); fixLbl.style.cssText = 'color:#9aa;font-size:12px';
  const fixWrap = document.createElement('div'); fixWrap.append(fix, fixNote);
  fixRow.append(fixLbl, fixWrap); nrm.appendChild(fixRow);
  right.appendChild(nrm);

  const emi = matSection('Emission');
  matRow(emi, 'Цвет', renderColorField(m.emissive ?? [0, 0, 0], (v) => { m.emissive = v; live(); }));
  matRow(emi, 'Интенсивность', matSlider(num(m.emissiveIntensity, 1), 0, 8, 0.1, (v) => { m.emissiveIntensity = v; live(); }));
  matRow(emi, 'Текстура', texSelect(textureIds(), str(m.emissiveMap), (v) => setTex('emissiveMap', v)));
  right.appendChild(emi);

  const occ = matSection('Occlusion');
  matRow(occ, 'AO Map', texSelect(textureIds(), str(m.aoMap), (v) => setTex('aoMap', v)));
  right.appendChild(occ);

  live();   // первичная отрисовка материала на сфере
  return box;
}
