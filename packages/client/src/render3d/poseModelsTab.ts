/**
 * ВКЛАДКА «МОДЕЛИ» поз-редактора (C5) — рабочий стол импорта скинед-мешей персонажа/оружия.
 * Поток: FBX/GLB (AccuRIG/CC) → `autoBoneMap` → `makeRetargetRig` → ЖИВОЙ ретаргет ведётся нашей позой
 * (`drive(human)` в loop) → правка карты костей / масштаба / материалов по сабмешам → Экспорт GLB
 * (`exportGLB`→`uploadAsset`) + запись `models`-записи в конфиг (`/api/dev/config-file` + live `/api/dev/config`).
 * Игра берёт GLB из конфига (`models[].url`). Редактор = конвертер; тяжёлый FBXLoader только тут, в игре — GLB.
 */
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { loadModelFile, loadModelUrl, exportGLB, uploadAsset, skeletonBoneNames } from './modelAssets.js';
import { autoBoneMap, makeRetargetRig, OUR_BONES, type RetargetRig } from './retarget3d.js';
import { getMaterial, type MaterialCfg, type TextureCfg } from './assetCache.js';

/** Запись меша в конфиге (зеркало modelsSchema; истина — config-секция `models`). */
interface ModelEntry {
  id: string; name: string; url: string; kind: 'part' | 'weapon';
  slot?: 'helm' | 'chest' | 'gloves' | 'boots' | 'head'; weaponType?: string;
  base: boolean; hideHair: boolean; scale: number;
  boneMap: Record<string, string>; submeshMaterials: Record<string, string>;
}
interface AssetCfg { models: ModelEntry[]; materials: MaterialCfg[]; textures: TextureCfg[] }

export interface ModelsTabHandle {
  render(body: HTMLElement): void;         // отрисовать UI вкладки в панель
  drive(source: Humanoid): void;           // per-кадр из loop(): наша поза ведёт импортный скелет
  hideMannequin(): boolean;                 // прятать ли манекен/призрак (чтобы виден был импорт)
  importUrl(url: string): Promise<void>;    // импорт по URL (тесты/дебаг — то же, что кнопка «Из URL»)
  exportNow(): Promise<void>;               // экспорт GLB + запись в конфиг (тесты/дебаг — то же, что кнопка)
  debug(): Record<string, unknown>;         // состояние (тесты/дебаг): загружено, карта костей, сабмеши, статус
  dispose(): void;
}

const css = {
  input: 'box-sizing:border-box;padding:3px 6px;background:#0f1119;color:#dfe3ee;border:1px solid #39415a;border-radius:4px;font:11px monospace',
  btn: 'margin:2px 3px 2px 0;padding:3px 8px;background:#2a3350;color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace',
  btnOn: 'margin:2px 3px 2px 0;padding:3px 8px;background:#3a5030;color:#dfe8d8;border:1px solid #5a7048;border-radius:4px;cursor:pointer;font:11px monospace',
};
const el = (tag: string, style = '', text = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = style; if (text) e.textContent = text; return e; };
const btn = (label: string, fn: () => void, on = false): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = on ? css.btnOn : css.btn; b.onclick = fn; return b; };

/** Инференс слота по имени сабмеша AccuRIG-модуляра (plate_armor→chest, legs→boots, hand→gloves, head/hair→head). */
function slotOfSubmesh(name: string): ModelEntry['slot'] | undefined {
  const n = name.toLowerCase();
  if (/helm|hood|cap|crown|tiara/.test(n)) return 'helm';
  if (/armor|plate|body|chest|torso|cloth|shirt|coat/.test(n)) return 'chest';
  if (/hand|glove|gaunt|heand/.test(n)) return 'gloves';
  if (/leg|boot|foot|pant|greave/.test(n)) return 'boots';
  if (/head|hair|face/.test(n)) return 'head';
  return undefined;
}

export function createModelsTab(scene: THREE.Scene): ModelsTabHandle {
  let cfg: AssetCfg = { models: [], materials: [], textures: [] };
  let loaded: THREE.Group | null = null;
  let rig: RetargetRig | null = null;
  let entry: ModelEntry | null = null;         // редактируемая запись (метаданные)
  let submeshes: THREE.Mesh[] = [];            // скинед-меши импорта (для назначения материалов)
  let hideMan = false;                         // прятать манекен (виден только импорт)
  let exporting = false;                       // на время экспорта не ведём (bind-поза)
  let status = '';                             // строка статуса под кнопками
  let bodyRef: HTMLElement | null = null;
  let upZ = false;                             // импорт Z-up (CC/AccuRIG FBX «лежит») → доворот −90°X в стойку Y-up

  // ── Загрузка эффективного конфига (истина — /api/config: дефолты + правки редактора) ──
  async function fetchCfg(): Promise<void> {
    try {
      const r = await fetch('/api/config'); if (!r.ok) return;
      const d = await r.json() as Record<string, unknown>;
      cfg = {
        models: Array.isArray(d.models) ? d.models as ModelEntry[] : [],
        materials: Array.isArray(d.materials) ? d.materials as MaterialCfg[] : [],
        textures: Array.isArray(d.textures) ? d.textures as TextureCfg[] : [],
      };
    } catch { /* сервер недоступен — пустой конфиг */ }
  }

  // ── Ось «вверх»: Z-up (глубина ≫ высоты у стоящего гуманоида) → модель лежит, доворачиваем в стойку ──
  function detectUpZ(obj: THREE.Object3D): boolean {
    obj.rotation.set(0, 0, 0); obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    return (box.max.z - box.min.z) > 1.4 * (box.max.y - box.min.y);
  }
  // ── Оценка масштаба: высота bbox (при текущем довороте) → к высоте манекена (TILE=32u=1м, гуманоид ~58u) ──
  function autoScale(obj: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(obj); const h = box.max.y - box.min.y;
    if (!(h > 1e-3)) return 1;
    return +(58 / h).toFixed(4);
  }

  // ── Собрать риг из загруженной сцены (доворот оси + масштаб + карта костей); заменить прежний.
  //    Доворот −90°X ставит Z-up модель в Y-up стойку ДО запекания rest-оффсетов (иначе ретаргет борется с осью). ──
  function buildRig(boneMap: Record<string, string>, scale: number): void {
    if (rig) { scene.remove(rig.root); rig.dispose(); rig = null; }
    if (!loaded) return;
    loaded.rotation.set(upZ ? -Math.PI / 2 : 0, 0, 0);
    rig = makeRetargetRig(loaded, { ...boneMap }, scale);
    scene.add(rig.root);
    submeshes = [];
    loaded.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) submeshes.push(o as THREE.Mesh); });
  }

  // preset — существующая config-запись (кнопка «загрузить»): сохраняем её метаданные/карту, иначе авто-инференс.
  async function importFrom(get: () => Promise<THREE.Group>, srcLabel: string, preset?: ModelEntry): Promise<void> {
    status = 'загрузка ' + srcLabel + '…'; renderBody();
    try {
      if (rig) { scene.remove(rig.root); rig.dispose(); rig = null; }
      loaded = await get();
      const boneNames = skeletonBoneNames(loaded);
      const auto = autoBoneMap(boneNames);
      upZ = detectUpZ(loaded);
      loaded.rotation.set(upZ ? -Math.PI / 2 : 0, 0, 0); loaded.updateMatrixWorld(true);   // измерять масштаб в стоящей позе
      if (preset) {
        entry = { ...preset, boneMap: { ...preset.boneMap }, submeshMaterials: { ...preset.submeshMaterials } };
        if (!Object.keys(entry.boneMap).length) entry.boneMap = auto;
      } else {
        const meshNames: string[] = []; loaded.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshNames.push(o.name); });
        const slot = meshNames.map(slotOfSubmesh).find(Boolean);
        entry = {
          id: srcLabel.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'model',
          name: srcLabel, url: '', kind: 'part', slot, base: false, hideHair: false, scale: autoScale(loaded),
          boneMap: auto, submeshMaterials: {},
        };
      }
      buildRig(entry.boneMap, entry.scale);
      for (const mesh of submeshes) { const mid = entry.submeshMaterials[mesh.name]; if (mid) applyMaterial(mesh, mid); }   // восстановить материалы
      const mapped = Object.values(entry.boneMap).filter(Boolean).length;
      status = `загружено: ${submeshes.length} сабмеш(ей), карта костей ${mapped}/${OUR_BONES.length}, масштаб ${entry.scale}`;
    } catch (e) { status = 'ошибка: ' + (e as Error).message; loaded = null; rig = null; }
    renderBody();
  }

  // ── Экспорт: bind-поза → GLB → upload → запись в config `models` ──
  async function exportToConfig(): Promise<void> {
    if (!rig || !loaded || !entry) return;
    status = 'экспорт…'; renderBody();
    exporting = true;
    try {
      for (const m of submeshes) { const s = (m as THREE.SkinnedMesh).skeleton; if (s) s.pose(); }   // bind-поза для чистого GLB
      // Экспорт с ЗАПЕЧЁННЫМ авторским трансформом (доворот оси Y-up + масштаб ~58u = наш рост): GLB сразу игро-размерный.
      // Игра грузит его как есть (makeRetargetRig scale=1 — уже нужного размера); config.scale — опц. доводка.
      loaded.updateMatrixWorld(true);
      const glb = await exportGLB(loaded);
      const up = await uploadAsset(entry.id, glb, 'model/gltf-binary');
      entry.url = up.url;
      entry.boneMap = { ...rig.boneMap };
      // В конфиг пишем scale=1: авторский масштаб/ось уже запечены в GLB (игра грузит как есть).
      const persisted: ModelEntry = { ...entry, scale: 1 };
      const models = cfg.models.slice();
      const i = models.findIndex((m) => m.id === persisted.id);
      if (i >= 0) models[i] = persisted; else models.push(persisted);
      const body = JSON.stringify({ models });
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });   // персист в data/models.json
      await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });         // live-оверрайд
      cfg.models = models;
      status = `сохранено: ${entry.id} → ${up.url} (${(glb.byteLength / 1024).toFixed(0)} КБ)`;
    } catch (e) { status = 'ошибка экспорта: ' + (e as Error).message; }
    exporting = false;
    renderBody();
  }

  async function deleteModel(id: string): Promise<void> {
    const models = cfg.models.filter((m) => m.id !== id);
    const body = JSON.stringify({ models });
    await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    cfg.models = models; renderBody();
  }

  // ── Назначить материал (из config `materials`) сабмешу ──
  function applyMaterial(mesh: THREE.Mesh, matId: string): void {
    if (!entry) return;
    if (!matId) { delete entry.submeshMaterials[mesh.name]; return; }
    const mat = getMaterial(cfg, matId);
    if (mat) { mesh.material = mat; entry.submeshMaterials[mesh.name] = matId; }
  }

  // ── UI ──
  function renderBody(): void { if (bodyRef) render(bodyRef); }

  function render(body: HTMLElement): void {
    bodyRef = body; body.innerHTML = '';

    // Импорт
    const imp = el('div', 'border:1px solid #2c3350;border-radius:6px;padding:6px;margin-bottom:6px');
    imp.append(el('div', 'color:#8fa0c0;font-size:11px;margin-bottom:4px', 'Импорт модели (FBX / GLB)'));
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.fbx,.glb,.gltf'; file.style.display = 'none';
    file.onchange = () => { const f = file.files?.[0]; if (f) void importFrom(() => loadModelFile(f), f.name); };
    const urlIn = document.createElement('input'); urlIn.type = 'text'; urlIn.value = '/assets/knight_02_modular_rig.fbx'; urlIn.style.cssText = css.input + ';width:100%;margin:3px 0';
    imp.append(btn('📁 Из файла', () => file.click()), file);
    imp.append(urlIn, btn('🌐 Из URL', () => { const u = urlIn.value.trim(); if (u) void importFrom(() => loadModelUrl(u), u.split('/').pop() ?? 'model'); }));
    imp.append(btn(hideMan ? '👁 показать манекен' : '🙈 спрятать манекен', () => { hideMan = !hideMan; renderBody(); }, hideMan));
    if (loaded) imp.append(btn('ось вверх: ' + (upZ ? 'Z→Y' : 'Y'), () => { upZ = !upZ; if (entry && loaded) { loaded.rotation.set(upZ ? -Math.PI / 2 : 0, 0, 0); loaded.updateMatrixWorld(true); entry.scale = autoScale(loaded); buildRig(entry.boneMap, entry.scale); } renderBody(); }, upZ));
    body.append(imp);

    if (status) body.append(el('div', 'color:#c8b06a;font-size:10px;margin:2px 0 6px', status));

    // Метаданные + карта костей + материалы редактируемой модели
    if (entry && rig) {
      const meta = el('div', 'border:1px solid #2c3350;border-radius:6px;padding:6px;margin-bottom:6px');
      meta.append(el('div', 'color:#8fa0c0;font-size:11px;margin-bottom:4px', 'Модель'));
      const row = (label: string, ctrl: HTMLElement): HTMLElement => { const r = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0'); r.append(el('span', 'color:#8b93a6;font-size:10px;min-width:64px', label), ctrl); ctrl.style.flex = '1'; return r; };
      const idIn = document.createElement('input'); idIn.type = 'text'; idIn.value = entry.id; idIn.style.cssText = css.input; idIn.oninput = () => { entry!.id = idIn.value.replace(/[^a-zA-Z0-9_-]/g, ''); };
      const nameIn = document.createElement('input'); nameIn.type = 'text'; nameIn.value = entry.name; nameIn.style.cssText = css.input; nameIn.oninput = () => { entry!.name = nameIn.value; };
      const kindSel = mkSelect(['part', 'weapon'], entry.kind, (v) => { entry!.kind = v as ModelEntry['kind']; renderBody(); });
      meta.append(row('id', idIn), row('имя', nameIn), row('вид', kindSel));
      if (entry.kind === 'part') {
        meta.append(row('слот', mkSelect(['', 'helm', 'chest', 'gloves', 'boots', 'head'], entry.slot ?? '', (v) => { entry!.slot = (v || undefined) as ModelEntry['slot']; })));
        const baseCb = mkCheck(entry.base, (v) => { entry!.base = v; }); const hairCb = mkCheck(entry.hideHair, (v) => { entry!.hideHair = v; });
        meta.append(row('база слота', baseCb), row('прятать волосы', hairCb));
      } else {
        meta.append(row('тип оружия', mkSelect(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff', 'shield'], entry.weaponType ?? 'sword', (v) => { entry!.weaponType = v; })));
      }
      const scaleIn = document.createElement('input'); scaleIn.type = 'number'; scaleIn.step = '0.001'; scaleIn.value = String(entry.scale); scaleIn.style.cssText = css.input;
      scaleIn.oninput = () => { const s = parseFloat(scaleIn.value); if (s > 0) { entry!.scale = s; buildRig(rig!.boneMap, s); } };
      meta.append(row('масштаб', scaleIn));
      body.append(meta);

      // Материалы по сабмешам
      if (submeshes.length) {
        const ms = el('div', 'border:1px solid #2c3350;border-radius:6px;padding:6px;margin-bottom:6px');
        ms.append(el('div', 'color:#8fa0c0;font-size:11px;margin-bottom:4px', 'Материалы по сабмешам'));
        const matIds = ['', ...cfg.materials.map((m) => m.id)];
        for (const mesh of submeshes) {
          const r = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0');
          r.append(el('span', 'color:#8b93a6;font-size:10px;min-width:90px;overflow:hidden;text-overflow:ellipsis', mesh.name || '(без имени)'));
          const sel = mkSelect(matIds, entry.submeshMaterials[mesh.name] ?? '', (v) => applyMaterial(mesh, v)); sel.style.flex = '1';
          r.append(sel); ms.append(r);
        }
        if (!cfg.materials.length) ms.append(el('div', 'color:#6b7180;font-size:9px', 'нет материалов в конфиге — создай во вкладке «3D: материалы»'));
        body.append(ms);
      }

      // Карта костей (наша → цель) — свёрнута
      const bmBox = el('details', 'border:1px solid #2c3350;border-radius:6px;padding:6px;margin-bottom:6px');
      const sum = document.createElement('summary'); sum.textContent = 'Карта костей (ретаргет)'; sum.style.cssText = 'color:#8fa0c0;font-size:11px;cursor:pointer'; bmBox.append(sum);
      const tgt = ['', ...rig.targetBoneNames()];
      for (const our of OUR_BONES) {
        const r = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0');
        r.append(el('span', 'color:#8b93a6;font-size:10px;min-width:96px', our));
        const sel = mkSelect(tgt, rig.boneMap[our] ?? '', (v) => { rig!.setBone(our, v); entry!.boneMap[our] = v; });
        sel.style.flex = '1'; r.append(sel); bmBox.append(r);
      }
      body.append(bmBox);

      body.append(btn('💾 Экспорт GLB + в конфиг', () => void exportToConfig()));
    }

    // Список моделей в конфиге
    const list = el('div', 'border:1px solid #2c3350;border-radius:6px;padding:6px');
    list.append(el('div', 'color:#8fa0c0;font-size:11px;margin-bottom:4px', `Модели в конфиге (${cfg.models.length})`));
    for (const m of cfg.models) {
      const r = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0');
      r.append(el('span', 'color:#c0c6d4;font-size:10px;flex:1', `${m.id} · ${m.kind}${m.slot ? '/' + m.slot : ''}`));
      r.append(btn('загрузить', () => { if (m.url) void importFrom(() => loadModelUrl(m.url).then((g) => { entry = { ...m }; return g; }), m.id); }));
      r.append(btn('✕', () => void deleteModel(m.id)));
      list.append(r);
    }
    body.append(list);
  }

  function mkSelect(opts: string[], val: string, on: (v: string) => void): HTMLSelectElement {
    const s = document.createElement('select'); s.style.cssText = css.input;
    for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o || '—'; if (o === val) op.selected = true; s.append(op); }
    s.onchange = () => on(s.value); return s;
  }
  function mkCheck(val: boolean, on: (v: boolean) => void): HTMLElement {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = val; c.onchange = () => on(c.checked);
    const w = el('div', 'display:flex'); w.append(c); return w;
  }

  void fetchCfg().then(renderBody);

  return {
    render,
    drive(source) { if (rig && !exporting) rig.drive(source); },
    hideMannequin: () => hideMan,
    importUrl: (url) => importFrom(() => loadModelUrl(url), url.split('/').pop() ?? 'model'),
    exportNow: () => exportToConfig(),
    debug: () => ({
      loaded: !!loaded, mappedBones: rig ? Object.values(rig.boneMap).filter(Boolean).length : 0,
      submeshes: submeshes.map((m) => m.name), status, upZ,
      entry: entry ? { id: entry.id, kind: entry.kind, slot: entry.slot, scale: entry.scale, url: entry.url } : null,
      configModels: cfg.models.map((m) => m.id), inScene: rig ? scene.children.includes(rig.root) : false,
    }),
    dispose() { if (rig) { scene.remove(rig.root); rig.dispose(); } },
  };
}
