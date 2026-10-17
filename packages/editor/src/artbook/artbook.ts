/**
 * ⭐ 16.10 (Артбук): ВЕРХНЯЯ ВКЛАДКА «🎨 Артбук» редактора конфигов — облик мира для художника и геймдизайнера: локации,
 * монстры (подтипы и архетипы нежити), персонажи, модели. Подвкладки и маршрут внутри каждой помнятся (localStorage).
 *
 * Состав:
 *  • `seed.ts` + `seed/*.json` — базовые тексты (в репозитории, грузятся отдельным чанком);
 *  • `model.ts` — чистое ядро: правки поверх сида по пути поля, картинки слотов, слияние двух машин;
 *  • `store.ts` — документ `pe_artbook` (localStorage сразу, сервер `/api/dev/pose` с задержкой и слиянием);
 *  • `widgets.ts` — правимый текст, слот картинок (загрузка `/api/dev/assets/<id>?dir=artbook`), миниатюра; `ui.ts` — кит;
 *  • страницы: `locations.ts`, `monsters.ts` (+ `monsterPages.ts`, `monsterNumbers.ts`; ⭐ 17.10 ростеры по ярусам — `rosterPages.ts`
 *    + чистое `roster.ts`), `characters.ts` (+ `classNumbers.ts`) — числа тем же кодом, что игра; «Модели» — заглушка до концептов.
 * Контракт страницы — `ctx.ts`.
 *
 * ⭐ 17.10: РОСТЕРЫ v2 (`seed/v2/*.json`, ~140 КБ на подтип) грузятся ЛЕНИВО по первому `ctx.roster(<подтип>)` / `ctx.rosterIndex()`,
 * по загрузке страница перерисовывается одним разом. В `ctx.seed` они лежат под `v2` (пути правки `v2/<подтип>/…`), а в `applyTexts`
 * не идут — сид клонируется на каждую отрисовку, и шесть ростеров сверху сделали бы её втрое дороже.
 */
import type { ConfigRegistry } from '@dm/shared';
import { applyTexts, editStats, slotState } from './model.js';
import { loadRoster, loadRosterIndex, loadSeed, type ArtbookSeed, type RosterIndex, type RosterV2 } from './seed.js';
import { artbookStore, SAVE_LABEL } from './store.js';
import { listWidget, saveOpenEditors, slotWidget, slotsWidget, textWidget, thumbWidget, whenNotEditing } from './widgets.js';
import { regFromData } from './classNumbers.js';
import type { ArtTab, ArtbookCtx } from './ctx.js';
import { renderLocations } from './locations.js';
import { renderMonsters } from './monsters.js';
import { renderCharacters } from './characters.js';
import { C, chip, el, h2, muted } from './ui.js';

const TABS: { id: ArtTab; label: string }[] = [
  { id: 'locations', label: '🏛 Локации' },
  { id: 'monsters', label: '💀 Монстры' },
  { id: 'characters', label: '🧙 Персонажи' },
  { id: 'models', label: '🧩 Модели' },
];

const LS = { tab: 'artbook_tab', routes: 'artbook_routes', edit: 'artbook_edit' } as const;
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* приватное окно */ } };

let tab: ArtTab = (() => { const t = lsGet(LS.tab); return TABS.some((x) => x.id === t) ? t as ArtTab : 'locations'; })();
const routes: Record<string, string> = (() => { try { return JSON.parse(lsGet(LS.routes) ?? '{}') as Record<string, string>; } catch { return {}; } })();
let canEdit = lsGet(LS.edit) !== '0';
/** Прокрутка по «подвкладка + маршрут»: «← назад» возвращает к тому же месту списка. */
const scrollMemo = new Map<string, number>();

let seed: ArtbookSeed | null = null;
let seedErr = '';

/** ⭐ 17.10: загруженные ростеры v2 (`<подтип>` / `index`), ошибки загрузки и загрузки в пути. */
const v2: Record<string, unknown> = {};
const v2Err = new Map<string, string>();
const v2Busy = new Set<string>();
let v2Redraw = false;
/** Перерисовать по загрузке ростера — одним разом на пачку загрузок (матрица ярусов ждёт шесть ростеров и сводку). */
const redrawSoon = (): void => {
  if (v2Redraw) return;
  v2Redraw = true;
  setTimeout(() => { v2Redraw = false; if (mounted?.host.isConnected) whenNotEditing(() => { if (mounted?.host.isConnected) mounted.draw(); }); }, 0);
};
function v2Get<T>(key: string, load: () => Promise<T>): T | null {
  if (key in v2) return v2[key] as T;
  if (!v2Busy.has(key) && !v2Err.has(key)) {
    v2Busy.add(key);
    load().then((x) => { v2[key] = x; }, (e: unknown) => { v2Err.set(key, e instanceof Error ? e.message : String(e)); })
      .finally(() => { v2Busy.delete(key); redrawSoon(); });
  }
  return null;
}

/** Смонтированная вкладка (одна): её перерисовка и обновление надписи сохранения. */
let mounted: { draw: () => void; status: () => void; host: HTMLElement } | null = null;

artbookStore.subscribe((kind) => {
  if (!mounted || !mounted.host.isConnected) return;
  if (kind === 'status') mounted.status();
  else whenNotEditing(() => { if (mounted?.host.isConnected) mounted.draw(); });
});
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mounted?.host.isConnected) void artbookStore.refresh();
});
// ⭐ 16.10: набранное в открытом поле правки не теряется и при закрытии / перезагрузке страницы — ложится в localStorage
// (как при любой перерисовке); на сервер его допишет следующая загрузка (слияние видит, что у нас есть то, чего там нет).
addEventListener('pagehide', () => { saveOpenEditors(); });

export interface ArtbookOpts { gotoConfig: (key: string) => void }

/** Отрисовать секцию «Артбук» в `host` (оболочка редактора зовёт на каждый показ секции). */
export function renderArtbookPage(host: HTMLElement, data: Record<string, unknown>, opts: ArtbookOpts): void {
  host.innerHTML = '';
  const root = el('div', 'flex:1;min-height:0;display:flex;flex-direction:column');
  host.append(root);

  const head = el('div', `flex:0 0 auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:0 0 8px;margin-bottom:8px;border-bottom:1px solid ${C.edgeSoft}`);
  const tabsBox = el('div', 'display:flex;gap:4px;flex-wrap:wrap');
  const right = el('div', 'margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px');
  const stats = el('span', `color:${C.dim}`);
  const saveLbl = el('span', `color:${C.dim}`);
  const editLbl = el('label', `display:flex;gap:5px;align-items:center;color:${C.dim};cursor:pointer;user-select:none`);
  const editBox = el('input'); editBox.type = 'checkbox'; editBox.checked = canEdit;
  editLbl.title = 'вкл — клик по тексту открывает правку; выкл — режим чтения';
  editLbl.append(editBox, document.createTextNode('✎ правка по клику'));
  right.append(stats, saveLbl, editLbl);
  head.append(tabsBox, right);
  const body = el('div', 'flex:1;min-height:0;overflow-y:auto;padding-right:6px');
  root.append(head, body);

  const status = (): void => {
    const s = artbookStore.save;
    saveLbl.textContent = SAVE_LABEL[s];
    saveLbl.style.color = s === 'offline' || s === 'denied' ? C.warn : C.dim;
    if (seed) {
      const st = editStats({ ...seed, v2 }, artbookStore.doc);
      const imgs = Object.values(artbookStore.doc.slots).reduce((n, l) => n + l.length, 0);
      const ok = Object.values(artbookStore.doc.slots).filter((l) => slotState(l) === 'approved').length;
      stats.textContent = `картинок ${imgs} · утверждённых слотов ${ok} · правок текста ${st.edited}${st.stale ? ` · ⚠ сид обновился: ${st.stale}` : ''}`;
      stats.style.color = st.stale ? C.warn : C.dim;
    }
  };

  const drawTabs = (): void => {
    tabsBox.innerHTML = '';
    for (const t of TABS) {
      const active = t.id === tab;
      const b = el('button', `padding:6px 13px;cursor:pointer;border-radius:6px;border:1px solid ${active ? C.active : C.edge};background:${active ? C.active : C.bg};color:${active ? '#fff' : '#b8b8c8'};font-weight:600;font-size:13px`, t.label);
      b.addEventListener('click', () => { if (t.id !== tab) { remember(); tab = t.id; lsSet(LS.tab, tab); draw(true); } });
      tabsBox.append(b);
    }
  };

  const routeKey = (): string => `${tab}|${routes[tab] ?? ''}`;
  const remember = (): void => { scrollMemo.set(routeKey(), body.scrollTop); };

  const go = (r: string): void => { remember(); routes[tab] = r; lsSet(LS.routes, JSON.stringify(routes)); draw(true); };

  let reg: ConfigRegistry | null = null;
  let regErr: string | undefined;
  let regTried = false;

  const draw = (navigated = false): void => {
    saveOpenEditors();   // набранное в открытых полях — сохранить до перерисовки
    drawTabs();
    status();
    const keep = navigated ? (scrollMemo.get(routeKey()) ?? 0) : body.scrollTop;
    body.innerHTML = '';
    if (seedErr) { body.append(el('div', `color:${C.bad};padding:16px`, '⚠ Не загрузились тексты артбука: ' + seedErr)); return; }
    if (!seed || !artbookStore.loaded) { body.append(muted('Загрузка артбука…', 'padding:16px')); return; }
    const sd = seed;
    // Сид с правками — заново на каждую отрисовку (копия черновика ~400 КБ — миллисекунды), чтобы страница не видела старое.
    const view = applyTexts(sd, artbookStore.doc.texts);
    regTried = false; reg = null; regErr = undefined;
    const ctx: ArtbookCtx = {
      data,
      reg: () => {
        if (!regTried) {
          regTried = true;
          try { reg = regFromData(data); } catch (e) { regErr = e instanceof Error ? e.message : String(e); }
        }
        if (!reg) throw new Error(regErr ?? 'конфиг не разобрался');
        return reg;
      },
      regError: () => regErr,
      seed: { ...sd, v2 }, view,
      doc: () => artbookStore.doc,
      commit: () => { artbookStore.touch(); draw(); },
      touch: () => { artbookStore.touch(); ctx.view = applyTexts(sd, artbookStore.doc.texts); status(); },
      rerender: () => draw(),
      route: routes[tab] ?? '',
      go,
      open: (t, r = '') => { remember(); tab = t; lsSet(LS.tab, tab); routes[t] = r; lsSet(LS.routes, JSON.stringify(routes)); draw(true); },
      canEdit,
      text: (path, o) => textWidget(ctx, path, o),
      list: (path, o) => listWidget(ctx, path, o),
      slot: (key, def, o) => slotWidget(ctx, key, def, o),
      slots: (prefix, defs, o) => slotsWidget(ctx, prefix, defs, o),
      thumb: (key, o) => thumbWidget(ctx, key, o),
      gotoConfig: (key) => opts.gotoConfig(key),
      roster: (id) => v2Get<RosterV2>(id, () => loadRoster(id)),
      rosterIndex: () => v2Get<RosterIndex>('index', loadRosterIndex),
      rosterError: (key) => v2Err.get(key),
      rosterRetry: (key) => { v2Err.delete(key); draw(); },
    };
    const page = el('div', 'max-width:1280px;padding-bottom:40px');
    body.append(page);
    try {
      if (tab === 'locations') renderLocations(page, ctx);
      else if (tab === 'monsters') renderMonsters(page, ctx);
      else if (tab === 'characters') renderCharacters(page, ctx);
      else renderModels(page, ctx);
    } catch (e) {
      console.error('[artbook]', e);
      page.append(el('div', `color:${C.bad};padding:12px`, '⚠ Страница упала: ' + (e instanceof Error ? e.message : String(e))));
    }
    body.scrollTop = keep;
  };

  editBox.addEventListener('change', () => { canEdit = editBox.checked; lsSet(LS.edit, canEdit ? '1' : '0'); draw(); });
  body.addEventListener('scroll', () => { scrollMemo.set(routeKey(), body.scrollTop); }, { passive: true });
  // Файл, брошенный мимо слота, браузер открыл бы вместо редактора (уход со страницы) — гасим; слоты ловят свои броски сами.
  const isFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  root.addEventListener('dragover', (e) => { if (isFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'none'; } });
  root.addEventListener('drop', (e) => { if (isFiles(e)) e.preventDefault(); });

  mounted = { draw: () => draw(), status, host: root };
  draw(true);
  if (!seed || !artbookStore.loaded) {
    Promise.all([loadSeed(), artbookStore.load()])
      .then(([s]) => { seed = s; seedErr = ''; })
      .catch((e: unknown) => { seedErr = e instanceof Error ? e.message : String(e); })
      .finally(() => { if (root.isConnected) draw(true); });
  } else void artbookStore.refresh();
}

/** «🧩 Модели» — заглушка: список моделей соберётся из утверждённых концептов (часть 3 черновика). */
function renderModels(host: HTMLElement, ctx: ArtbookCtx): void {
  host.append(h2('Модели'));
  host.append(muted('Появится после концептов. Когда концепты подтипов и карточек ростера (бойцы ярусов, боссы, особые) утверждены, по ним выписываются детали модульного персонажа (база тела на три яруса, голова, шлем, нагрудник — с ним руки и ноги, оружие по классам движка, щиты, насадки) — и здесь будет список моделей с повторами между ярусами и подтипами. Комплект моделей по ярусам каждого подтипа — на его странице («Монстры» → подтип → «Ярусы (v2)»).', 'max-width:820px;line-height:1.5;margin-bottom:12px'));
  const slots = Object.entries(ctx.doc().slots);
  const approved = slots.filter(([, l]) => slotState(l) === 'approved');
  const box = el('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center');
  box.append(chip(`слотов с картинками: ${slots.length}`, C.dim), chip(`утверждённых: ${approved.length}`, approved.length ? C.ok : C.faint));
  host.append(box);
}
