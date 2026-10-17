/**
 * ⭐ 16.10 (Артбук): ОБЩИЕ ВИДЖЕТЫ страниц — правимый текст, слот картинок, миниатюра. Страницы зовут их через контекст
 * (`ctx.text`, `ctx.slot`, `ctx.thumb`), а не напрямую.
 *
 *  • ТЕКСТ: клик → поле правки → «Сохранить» (Ctrl+Enter) / «Отмена» (Esc) / «Текст сида». Правка обновляет только своё поле
 *    (`ctx.touch()`), поэтому рядом открытые правки не теряются. Правленое помечено «✎», под обновившимся сидом — «⚠ сид
 *    обновился» (показать новый текст, взять его или оставить свой).
 *  • СЛОТ: перетащить файлы (png / jpg / webp) или «+ Добавить» → `POST /api/dev/assets/<id>?dir=artbook` (`devFetch`) →
 *    картинка в слоте. У картинки — подпись, статус (нет / черновик / утверждён), ★ главный, ← → порядок, ✕ убрать из списка
 *    (файл на сервере остаётся), клик — крупно. Нет сервера или прав — текст ошибки в слоте, вкладка работает дальше.
 */
import { devFetch } from '@dm/client/devAuth.js';
import {
  ARTBOOK_DIR, IMG_STATUSES, STATUS_LABEL, addImage, coverOf, editText, imageContentType, keepEdit, mainOf, moveImage,
  removeImage, resetText, setMain, slotImages, slotKey, slotState, textState, updateImage, uploadId, uploadProblem, getAt,
  type ImgStatus, type SlotDef, type SlotImage,
} from './model.js';
import type { ArtbookCtx, ListOpts, SlotOpts, TextOpts, ThumbOpts } from './ctx.js';
import { C, btn, chip, el, openLightbox, placeholder, richText, statusChip, STATUS_COLOR } from './ui.js';

// ── Текст ────────────────────────────────────────────────────────────────────────────────────────

/** Сколько полей сейчас в правке: пока > 0, чужие правки с сервера не перерисовывают страницу (`artbook.ts`). */
let editing = 0;
export const isEditing = (): boolean => editing > 0;
/** Чем закончить отложенную перерисовку, когда правки закрыты. */
let afterEdit: (() => void) | null = null;
export function whenNotEditing(fn: () => void): void { if (editing > 0) afterEdit = fn; else fn(); }
const endEdit = (): void => {
  editing = Math.max(0, editing - 1);
  if (!editing && afterEdit) { const f = afterEdit; afterEdit = null; setTimeout(f, 0); }
};
/** Открытые поля правки → их «сохранить». Перерисовка страницы (★, статус, загрузка) сначала сохраняет набранное — не теряет. */
const openEditors = new Set<() => void>();
export function saveOpenEditors(): void { for (const f of [...openEditors]) f(); }

const fmtWhen = (at: number): string => {
  if (!at) return '';
  const d = new Date(at);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function textWidget(ctx: ArtbookCtx, path: string, opts: TextOpts = {}): HTMLElement {
  const tag = opts.tag ?? 'div';
  const box = el(tag, `${tag === 'span' ? '' : 'margin:0 0 6px;'}line-height:1.5;color:${C.soft};white-space:pre-wrap;${opts.css ?? ''}`);
  const editable = ctx.canEdit && !opts.readonly;

  const show = (): void => {
    box.innerHTML = '';
    const st = textState(ctx.seed, ctx.doc(), path);
    if (st.value) {
      // ⭐ 17.10: жирное начало (заголовок пункта сводки), если текст по-прежнему с него начинается.
      const lead = opts.lead && st.value.startsWith(opts.lead) ? opts.lead : '';
      if (lead) box.append(el('b', `color:${C.text}`, lead));
      const rest = st.value.slice(lead.length);
      if (rest) box.append(opts.plain ? document.createTextNode(rest) : richText(rest));
    } else if (editable) box.append(el('span', `color:${C.faint};font-style:italic`, opts.placeholder ?? 'пусто — нажми, чтобы написать'));
    if (st.edited) {
      const mark = el('sup', `color:${C.accent};margin-left:3px;font-size:10px;cursor:help`, '✎');
      mark.title = `правлено владельцем ${fmtWhen(ctx.doc().texts[path]?.at ?? 0)}`;
      box.append(mark);
    }
    if (st.stale) {
      const c = chip('⚠ сид обновился', C.warn, 'текст в репозитории поменялся после твоей правки — посмотреть');
      c.style.cursor = 'pointer'; c.style.marginLeft = '6px';
      c.addEventListener('click', (e) => { e.stopPropagation(); toggleSeed(); });
      box.append(c);
    }
    box.title = editable ? 'нажми, чтобы править' : '';
    box.style.cursor = editable ? 'text' : '';
    box.style.borderRadius = '4px';
  };

  // Новый текст сида под правкой владельца: показать, взять, оставить своё.
  let seedBox: HTMLElement | null = null;
  const toggleSeed = (): void => {
    if (seedBox) { seedBox.remove(); seedBox = null; return; }
    const st = textState(ctx.seed, ctx.doc(), path);
    seedBox = el('div', `margin:4px 0 8px;padding:8px 10px;border:1px solid ${C.warn}55;border-radius:6px;background:${C.input};white-space:pre-wrap;font-size:12.5px;color:${C.soft}`);
    seedBox.append(el('div', `color:${C.warn};font-size:11px;margin-bottom:4px`, 'Новый текст сида:'), document.createTextNode(st.seedValue ?? ''));
    const row = el('div', 'display:flex;gap:6px;margin-top:6px');
    row.append(
      btn('Взять новый текст', () => { if (resetText(ctx.doc(), path, Date.now())) ctx.touch(); seedBox?.remove(); seedBox = null; show(); }),
      btn('Оставить мой', () => { if (keepEdit(ctx.doc(), ctx.seed, path, Date.now())) ctx.touch(); seedBox?.remove(); seedBox = null; show(); }),
    );
    seedBox.append(row);
    seedBox.addEventListener('click', (e) => e.stopPropagation());
    box.after(seedBox);
  };

  const edit = (): void => {
    const st = textState(ctx.seed, ctx.doc(), path);
    editing++;
    box.innerHTML = '';
    box.style.cursor = '';
    box.style.outline = '';
    box.title = '';
    seedBox?.remove(); seedBox = null;
    const field = opts.single ? el('input') : el('textarea');
    field.value = st.value;
    field.style.cssText = `box-sizing:border-box;width:100%;padding:6px 8px;background:${C.input};color:${C.text};border:1px solid ${C.accent}88;border-radius:5px;font:inherit;font-size:13px;line-height:1.5;resize:vertical`;
    if (field instanceof HTMLTextAreaElement) {
      const fit = (): void => { field.style.height = 'auto'; field.style.height = Math.min(480, Math.max(54, field.scrollHeight + 4)) + 'px'; };
      field.addEventListener('input', fit);
      requestAnimationFrame(fit);
    }
    let done = false;
    const close = (): void => { if (done) return; done = true; openEditors.delete(saveIt); endEdit(); if (box.isConnected) show(); };
    const saveIt = (): void => {
      if (done) return;
      if (editText(ctx.doc(), ctx.seed, path, field.value, Date.now())) ctx.touch();
      close();
    };
    openEditors.add(saveIt);
    const row = el('div', 'display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap');
    row.append(btn('Сохранить', saveIt, `background:${C.active}`), btn('Отмена', close));
    if (st.edited) row.append(btn('Текст сида', () => { if (done) return; if (resetText(ctx.doc(), path, Date.now())) ctx.touch(); close(); }, `color:${C.dim}`));
    row.append(el('span', `font-size:11px;color:${C.faint}`, 'Ctrl+Enter — сохранить, Esc — отмена'));
    field.addEventListener('keydown', (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Escape') { k.preventDefault(); close(); }
      else if (k.key === 'Enter' && (k.ctrlKey || k.metaKey || opts.single)) { k.preventDefault(); saveIt(); }
    });
    const wrap = el('div', '');
    wrap.append(field, row);
    wrap.addEventListener('click', (e) => e.stopPropagation());
    box.append(wrap);
    field.focus();
  };

  box.addEventListener('click', (e) => {
    if (!editable || box.querySelector('textarea,input')) return;
    if ((window.getSelection()?.toString() ?? '').length > 0) return;   // выделяли текст, чтобы скопировать, — не правка
    e.stopPropagation();
    edit();
  });
  if (editable) {
    box.addEventListener('mouseenter', () => { if (!box.querySelector('textarea,input')) box.style.outline = `1px dashed ${C.edge}`; });
    box.addEventListener('mouseleave', () => { box.style.outline = ''; });
  }
  show();
  return box;
}

/** Что видно в поле: правка владельца или текст сида (для подписей кнопок и выпадашек, где правимый виджет не годится). */
export const fieldValue = (ctx: ArtbookCtx, path: string): string => textState(ctx.seed, ctx.doc(), path).value;

/**
 * Поле есть — в сиде или в правке: стёртое владельцем поле сида остаётся на странице (пустым), иначе его не вернуть «Текстом
 * сида». Строка — непустая, массив — с пунктами.
 */
export const hasField = (ctx: ArtbookCtx, path: string): boolean => {
  if (path in ctx.doc().texts) return true;
  return [ctx.seed, ctx.view].some((root) => {
    const v = getAt(root, path);
    return (typeof v === 'string' && v.trim() !== '') || (Array.isArray(v) && v.length > 0);
  });
};

export function listWidget(ctx: ArtbookCtx, path: string, opts: ListOpts = {}): HTMLElement {
  const arr = getAt(ctx.seed, path);
  const n = Array.isArray(arr) ? arr.length : 0;
  if (opts.paragraphs) {
    const box = el('div', '');
    for (let i = 0; i < n; i++) box.append(textWidget(ctx, `${path}/${i}`, opts));
    return box;
  }
  const list = el(opts.ordered ? 'ol' : 'ul', 'margin:2px 0 8px;padding-left:20px');
  for (let i = 0; i < n; i++) {
    const li = el('li', `margin:2px 0;color:${C.soft}`);
    li.append(textWidget(ctx, `${path}/${i}`, { ...opts, tag: 'div', css: `margin:0;${opts.css ?? ''}` }));
    list.append(li);
  }
  return list;
}

// ── Картинки ─────────────────────────────────────────────────────────────────────────────────────

/** Заливки в процессе и последняя ошибка по слоту — переживают перерисовку страницы. */
const uploading = new Map<string, number>();
const errors = new Map<string, string>();

/** Человеческая причина отказа ручки загрузки. */
function uploadError(status: number): string {
  if (status === 401) return 'нужен вход администратора — картинка не загружена';
  if (status === 403) return 'нет прав на загрузку (нужна роль admin; на проде запись выключена)';
  if (status === 413) return 'файл слишком большой (предел сервера — 64 МБ)';
  if (status === 415 || status === 400) return 'сервер не принял файл (нужен png, jpg или webp)';
  if (status >= 500) return `сервер ответил ошибкой ${status}`;
  return `не загрузилось (ответ ${status})`;
}

/** Залить файл на сервер. Бросает `Error` с текстом для слота. */
async function uploadImage(file: File, key: string): Promise<{ id: string; url: string }> {
  const bad = uploadProblem(file.name, file.type, file.size);   // тип, пустой файл, предел сервера — до сети
  if (bad) throw new Error(bad);
  const type = imageContentType(file.name, file.type)!;
  const id = uploadId(key, Date.now(), Math.random() * 1e9);
  let r: Response;
  try {
    r = await devFetch(`/api/dev/assets/${encodeURIComponent(id)}?dir=${ARTBOOK_DIR}`, {
      method: 'POST', headers: { 'content-type': type }, body: await file.arrayBuffer(),
    });
  } catch { throw new Error('сервер недоступен — картинка не загружена'); }
  if (!r.ok) throw new Error(uploadError(r.status));
  const j = await r.json().catch(() => ({})) as { url?: string };
  if (!j.url) throw new Error('сервер не вернул адрес файла');
  return { id, url: j.url };
}

async function addFiles(ctx: ArtbookCtx, key: string, files: readonly File[]): Promise<void> {
  const list = [...files];
  if (!list.length) return;
  errors.delete(key);
  uploading.set(key, (uploading.get(key) ?? 0) + list.length);
  ctx.rerender();
  const fails: string[] = [];
  for (const f of list) {
    try {
      const { id, url } = await uploadImage(f, key);
      addImage(ctx.doc(), key, { id, url, name: f.name }, Date.now());
      ctx.touch();
    } catch (e) { fails.push(e instanceof Error ? e.message : String(e)); }
    uploading.set(key, Math.max(0, (uploading.get(key) ?? 1) - 1));
  }
  if (!uploading.get(key)) uploading.delete(key);
  if (fails.length) errors.set(key, [...new Set(fails)].join('; '));
  ctx.rerender();
}

function pickFiles(onPick: (files: File[]) => void): void {
  const inp = el('input');
  inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp'; inp.multiple = true;
  inp.addEventListener('change', () => { onPick(inp.files ? [...inp.files] : []); });
  inp.click();
}

/** Управление одной картинкой: ★, ← →, статус, подпись, ✕. */
function imageControls(ctx: ArtbookCtx, key: string, img: SlotImage, list: readonly SlotImage[], withCaption: boolean): HTMLElement {
  const box = el('div', 'display:flex;flex-direction:column;gap:3px;margin-top:4px');
  const row = el('div', 'display:flex;gap:3px;align-items:center;flex-wrap:wrap');
  const mini = 'padding:1px 6px;font-size:11px;border-radius:4px';
  const star = btn(img.main ? '★' : '☆', () => { if (setMain(ctx.doc(), key, img.id, Date.now())) ctx.commit(); }, `${mini};color:${img.main ? C.gold : C.dim}`);
  star.title = img.main ? 'главная картинка слота' : 'сделать главной';
  const sel = el('select', `${mini};background:${C.input};color:${STATUS_COLOR[img.status]};border:1px solid ${C.edge}`);
  for (const s of IMG_STATUSES) { const o = el('option', '', STATUS_LABEL[s]); o.value = s; if (s === img.status) o.selected = true; sel.append(o); }
  sel.title = 'статус картинки';
  sel.addEventListener('click', (e) => e.stopPropagation());
  sel.addEventListener('change', () => { if (updateImage(ctx.doc(), key, img.id, { status: sel.value as ImgStatus }, Date.now())) ctx.commit(); });
  row.append(star, sel);
  if (list.length > 1) {
    const i = list.indexOf(img);
    if (i > 0) row.append(btn('←', () => { if (moveImage(ctx.doc(), key, img.id, -1, Date.now())) ctx.commit(); }, mini));
    if (i < list.length - 1) row.append(btn('→', () => { if (moveImage(ctx.doc(), key, img.id, 1, Date.now())) ctx.commit(); }, mini));
  }
  const del = btn('✕', () => {
    if (!confirm('Убрать картинку из слота? Файл на сервере останется.')) return;
    if (removeImage(ctx.doc(), key, img.id, Date.now())) ctx.commit();
  }, `${mini};color:${C.bad};margin-left:auto`);
  del.title = 'убрать из списка (файл на сервере не удаляется)';
  row.append(del);
  box.append(row);
  if (withCaption) {
    const cap = el('input', `box-sizing:border-box;width:100%;padding:3px 6px;background:${C.input};color:${C.text};border:1px solid ${C.edge};border-radius:4px;font-size:11.5px`);
    cap.value = img.caption; cap.placeholder = 'подпись';
    cap.addEventListener('click', (e) => e.stopPropagation());
    const commitCap = (): void => { if (updateImage(ctx.doc(), key, img.id, { caption: cap.value.trim() }, Date.now())) ctx.touch(); };
    cap.addEventListener('change', commitCap);
    cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cap.blur(); } });
    box.append(cap);
  }
  return box;
}

function imgEl(img: SlotImage, css: string): HTMLImageElement {
  const im = el('img', `display:block;object-fit:contain;background:#0b0b10;border-radius:5px;cursor:zoom-in;${css}`);
  im.src = img.url; im.alt = img.caption || img.name || ''; im.loading = 'lazy';
  im.title = img.caption || img.name || '';
  im.addEventListener('error', () => { im.style.opacity = '0.3'; im.title = 'файл не открылся: ' + img.url; }, { once: true });
  return im;
}

export function slotWidget(ctx: ArtbookCtx, key: string, defIn: SlotDef | string, opts: SlotOpts = {}): HTMLElement {
  const def: SlotDef = typeof defIn === 'string' ? { id: key, title: defIn } : defIn;
  const layout = opts.layout ?? 'grid';
  const list = slotImages(ctx.doc(), key);
  const box = el('div', `border:1px solid ${C.edgeSoft};border-radius:8px;background:${C.bg};padding:8px 10px;margin:0 0 10px;transition:border-color .1s`);

  const head = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap');
  head.append(el('span', `font-weight:600;font-size:13px;color:${C.text}`, def.title), statusChip(slotState(list)));
  if (list.length) head.append(el('span', `font-size:11.5px;color:${C.faint}`, `${list.length} шт.`));
  const up = uploading.get(key);
  if (up) head.append(chip(`загрузка… ${up}`, C.accent));
  const add = btn('+ Добавить', () => pickFiles((f) => { void addFiles(ctx, key, f); }), 'margin-left:auto;padding:3px 9px');
  head.append(add);
  box.append(head);
  const hint = opts.hint ?? def.hint;
  if (hint && layout !== 'compact') box.append(el('div', `font-size:11.5px;color:${C.faint};margin:2px 0 0`, hint));
  const err = errors.get(key);
  if (err) {
    const e = el('div', `font-size:12px;color:${C.bad};margin:4px 0 0;display:flex;gap:6px;align-items:center`, '⚠ ' + err);
    e.append(btn('скрыть', () => { errors.delete(key); ctx.rerender(); }, 'padding:0 6px;font-size:11px'));
    box.append(e);
  }

  const zoom = (img: SlotImage): void => openLightbox(list, list.indexOf(img), def.title);
  const body = el('div', 'margin-top:8px');
  if (!list.length) {
    body.append(placeholder('Перетащи сюда картинку (png, jpg, webp) или нажми «+ Добавить»', '100%', layout === 'hero' ? 220 : layout === 'compact' ? 56 : 110));
  } else if (layout === 'hero') {
    const main = mainOf(list)!;
    const mainBox = el('div', 'max-width:720px');
    mainBox.append(imgEl(main, 'width:100%;max-height:420px;min-height:160px'));
    mainBox.lastElementChild!.addEventListener('click', () => zoom(main));
    mainBox.append(imageControls(ctx, key, main, list, true));
    body.append(mainBox);
    const rest = list.filter((x) => x !== main);
    if (rest.length) {
      body.append(el('div', `font-size:11.5px;color:${C.dim};margin:10px 0 4px`, `Варианты (${rest.length})`));
      const strip = el('div', 'display:flex;gap:8px;flex-wrap:wrap');
      for (const img of rest) {
        const t = el('div', 'width:112px');
        const im = imgEl(img, 'width:112px;height:112px'); im.addEventListener('click', () => zoom(img));
        t.append(im, imageControls(ctx, key, img, list, true));
        strip.append(t);
      }
      body.append(strip);
    }
  } else if (layout === 'compact') {
    const strip = el('div', 'display:flex;gap:6px;flex-wrap:wrap');
    for (const img of list) {
      const im = imgEl(img, `width:64px;height:64px;${img.main ? `outline:2px solid ${C.gold}55` : ''}`);
      im.addEventListener('click', () => zoom(img));
      strip.append(im);
    }
    body.append(strip);
  } else {
    const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px');
    for (const img of list) {
      const t = el('div', 'min-width:0');
      const im = imgEl(img, `width:100%;height:150px;${img.main ? `outline:2px solid ${C.gold}66` : ''}`);
      im.addEventListener('click', () => zoom(img));
      t.append(im, imageControls(ctx, key, img, list, true));
      grid.append(t);
    }
    body.append(grid);
  }
  box.append(body);

  // Перетаскивание файлов на весь слот.
  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  box.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = 'copy'; box.style.borderColor = C.accent; });
  box.addEventListener('dragleave', (e) => { if (e.target === box || !box.contains(e.relatedTarget as Node)) box.style.borderColor = C.edgeSoft; });
  box.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); box.style.borderColor = C.edgeSoft;
    void addFiles(ctx, key, e.dataTransfer ? [...e.dataTransfer.files] : []);
  });
  return box;
}

export function slotsWidget(ctx: ArtbookCtx, prefix: string[], defs: readonly SlotDef[], opts: SlotOpts = {}): HTMLElement {
  const box = el('div', '');
  defs.forEach((d, i) => box.append(slotWidget(ctx, slotKey(...prefix, d.id), d, { ...opts, layout: opts.layout ?? (i === 0 && d.id === 'concept' ? 'hero' : 'grid') })));
  return box;
}

/** Миниатюра слота для списков и матрицы: утверждённая обложка или пунктир с числом черновиков. */
export function thumbWidget(ctx: ArtbookCtx, key: string, opts: ThumbOpts = {}): HTMLElement {
  const w = opts.w ?? 96, h = opts.h ?? w;
  const list = slotImages(ctx.doc(), key);
  const cover = coverOf(list);
  if (!cover) {
    const drafts = list.length;
    const p = placeholder(drafts ? `черновик (${drafts})` : (opts.empty ?? 'нет концепта'), w, h, drafts ? `border-color:${C.warn}66;color:${C.warn}` : '');
    if (drafts && opts.zoom) { p.style.cursor = 'zoom-in'; p.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(list, 0); }); }
    return p;
  }
  const im = imgEl(cover, `width:${w}px;height:${h}px;${opts.zoom ? '' : 'cursor:inherit'}`);
  if (opts.zoom) im.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(list, list.indexOf(cover)); });
  return im;
}
