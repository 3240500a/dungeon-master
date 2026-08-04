/**
 * Редактор префабов комнат/этажей — рисование ПО КЛЕТКАМ. Два слоя: террейн (пол/стена/колонна/
 * дверь-проём) и зоны контента (декор/монстр/сундук/вход/выход) — генератор при генерации ставит
 * туда подходящий контент. `scope`: room = часть этажа (вставляется вместо процедурной комнаты),
 * floor = целый этаж. Пишет прямо в объект префаба (рабочая копия data); сохранение — кнопкой «Применить».
 */
import { rotatePrefabCW, mirrorPrefab, trimPrefab, type RoomPrefab } from '@dm/shared';

export type { RoomPrefab };

const TERR = [
  { ch: '.', name: 'Пол', color: '#cbb489' },
  { ch: '#', name: 'Стена', color: '#20202c' },
  { ch: 'o', name: 'Колонна', color: '#8a6a3a' },
  { ch: '+', name: 'Дверь', color: '#c98a3a' },
] as const;
const ZONE = [
  { ch: 'd', name: 'Декор', color: '#8a5cff' },
  { ch: 'm', name: 'Монстр', color: '#e05050' },
  { ch: 'c', name: 'Сундук', color: '#e8c24a' },
  { ch: 'e', name: 'Вход', color: '#3ad06f' },
  { ch: 'x', name: 'Выход', color: '#f87171' },
] as const;
const TERR_CH = '.#o+', ZONE_CH = 'dmcex';
const VOID = ' '; // клетка вне комнаты (пусто) — при генерации пропускается → форма произвольная
const VOID_COLOR = '#0e0e16';

const setChar = (s: string, i: number, ch: string): string => s.slice(0, i) + ch + s.slice(i + 1);

/** Дотягивает terrain/zones до h строк по w символов; НЕнарисованные клетки → пусто (рисуешь форму сам). */
function normalize(p: RoomPrefab): void {
  const t: string[] = [], z: string[] = [];
  for (let y = 0; y < p.h; y++) {
    const tr = p.terrain[y] ?? '', zr = p.zones[y] ?? '';
    let nt = '', nz = '';
    for (let x = 0; x < p.w; x++) {
      const c = tr[x];
      nt += c && (TERR_CH.includes(c) || c === VOID) ? c : VOID;
      const zc = zr[x];
      nz += zc && ZONE_CH.includes(zc) ? zc : ' ';
    }
    t.push(nt); z.push(nz);
  }
  p.terrain = t; p.zones = z;
}

/** Типы генерации, куда может попасть префаб. room-scope вставляется в rooms/bsp; floor-scope — алгоритмом prefab. */
const ALGO_OPTS: Record<'room' | 'floor', { id: string; name: string }[]> = {
  room: [{ id: 'rooms', name: 'Комнаты' }, { id: 'bsp', name: 'BSP' }, { id: 'cellular', name: 'Пещеры' }, { id: 'maze', name: 'Лабиринт' }],
  floor: [{ id: 'prefab', name: 'Префаб-этаж' }],
};

export function renderRoomEditor(prefab: RoomPrefab, biomeOptions: { id: string; name: string }[], onStructural: () => void): HTMLElement {
  normalize(prefab);
  prefab.biomes ??= []; prefab.algorithms ??= []; // старые записи без полей отбора
  let brush: { layer: 'terrain' | 'zone' | 'erase'; ch: string } = { layer: 'terrain', ch: '.' };

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:0';

  // ── Шапка: имя / scope / размеры ──
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
  const mkLabeled = (label: string, el: HTMLElement): HTMLElement => { const d = document.createElement('label'); d.style.cssText = 'display:flex;gap:5px;align-items:center;font-size:12px;color:#a8a8be'; d.append(label, el); return d; };
  const inp = (value: string | number, on: (v: string) => void, w = '120px'): HTMLInputElement => { const i = document.createElement('input'); i.value = String(value); i.style.cssText = `width:${w};padding:4px 6px;background:#111119;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:5px;font-size:12px`; i.addEventListener('change', () => on(i.value)); return i; };

  head.append(
    mkLabeled('id', inp(prefab.id, (v) => { prefab.id = v.trim(); onStructural(); })),
    mkLabeled('Имя', inp(prefab.name, (v) => { prefab.name = v; onStructural(); })),
  );
  const scopeSel = document.createElement('select');
  scopeSel.style.cssText = 'padding:4px 6px;background:#111119;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:5px;font-size:12px';
  for (const [val, lab] of [['room', 'Комната (часть этажа)'], ['floor', 'Целый этаж']] as const) { const o = document.createElement('option'); o.value = val; o.textContent = lab; if (prefab.scope === val) o.selected = true; scopeSel.append(o); }
  scopeSel.addEventListener('change', () => { prefab.scope = scopeSel.value as 'room' | 'floor'; onStructural(); });
  head.append(mkLabeled('Тип', scopeSel));
  const resize = (nw: number, nh: number): void => { prefab.w = Math.max(3, Math.min(80, nw | 0)); prefab.h = Math.max(3, Math.min(80, nh | 0)); normalize(prefab); onStructural(); };
  head.append(
    mkLabeled('Ширина', inp(prefab.w, (v) => resize(Number(v), prefab.h), '56px')),
    mkLabeled('Высота', inp(prefab.h, (v) => resize(prefab.w, Number(v)), '56px')),
  );
  wrap.append(head);

  // ── Отбор: биомы + типы генерации (чипы-переключатели; пустой набор = «во всех») ──
  const filterWrap = document.createElement('div');
  filterWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid #2c2c3a;border-radius:6px;background:#13131b';
  const chipRow = (title: string, options: { id: string; name: string }[], arr: string[]): void => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    const lab = document.createElement('span'); lab.textContent = title; lab.style.cssText = 'font-size:12px;color:#a8a8be;min-width:118px';
    row.append(lab);
    const note = document.createElement('span'); note.style.cssText = 'font-size:11px;color:#71718a;margin-left:2px';
    const syncNote = (): void => { note.textContent = arr.length ? '' : '· во всех'; };
    if (!options.length) { const s = document.createElement('span'); s.textContent = '(нет вариантов)'; s.style.cssText = 'font-size:12px;color:#71718a'; row.append(s); filterWrap.append(row); return; }
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.name;
      const on = (): boolean => arr.includes(o.id);
      const style = (): void => { b.style.cssText = `padding:3px 10px;cursor:pointer;border-radius:12px;font-size:12px;border:1px solid ${on() ? '#dca94b' : '#2c2c3a'};background:${on() ? '#3a3320' : '#1c1c26'};color:${on() ? '#f0d9a8' : '#c8c8d8'}`; };
      b.addEventListener('click', () => { const i = arr.indexOf(o.id); if (i >= 0) arr.splice(i, 1); else arr.push(o.id); style(); syncNote(); });
      style(); row.append(b);
    }
    row.append(note); syncNote(); filterWrap.append(row);
  };
  chipRow('Биомы:', biomeOptions, prefab.biomes);
  chipRow('Типы генерации:', ALGO_OPTS[prefab.scope === 'floor' ? 'floor' : 'room'], prefab.algorithms);
  const fNote = document.createElement('div');
  fNote.style.cssText = 'font-size:11px;color:#71718a';
  fNote.textContent = prefab.scope === 'floor'
    ? 'Целый этаж из этого префаба строит алгоритм «prefab» (задай его этажу в «Этажи»).'
    : 'Появится в комнате этажа, если у типа этажа («Этажи» → «Шанс префаба» > 0) И совпадает биом/тип генерации.';
  filterWrap.append(fNote);
  wrap.append(filterWrap);

  // ── Палитра кистей ──
  const pal = document.createElement('div');
  pal.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  const brushBtns: { el: HTMLButtonElement; layer: string; ch: string }[] = [];
  const refreshBrush = (): void => brushBtns.forEach((b) => { b.el.style.outline = (b.layer === brush.layer && b.ch === brush.ch) ? '2px solid #dca94b' : 'none'; });
  const brushBtn = (label: string, color: string, layer: 'terrain' | 'zone' | 'erase', ch: string): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:4px 9px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:#1c1c26;color:#e8e8f0;font-size:12px;display:flex;align-items:center;gap:5px`;
    b.insertAdjacentHTML('afterbegin', `<span style="width:11px;height:11px;border-radius:3px;background:${color};display:inline-block;border:1px solid #0006"></span>`);
    b.addEventListener('click', () => { brush = { layer, ch }; refreshBrush(); });
    pal.append(b); brushBtns.push({ el: b, layer, ch });
  };
  const palLabel = (text: string, ml = '0'): HTMLElement => { const s = document.createElement('span'); s.textContent = text; s.style.cssText = `font-size:12px;color:#71718a;margin-left:${ml}`; return s; };
  pal.append(palLabel('Террейн:'));
  for (const t of TERR) brushBtn(t.name, t.color, 'terrain', t.ch);
  brushBtn('Пусто (стереть)', VOID_COLOR, 'terrain', VOID); // удалить клетку → вне комнаты (произвольная форма)
  pal.append(palLabel('Зоны:', '8px'));
  for (const z of ZONE) brushBtn(z.name, z.color, 'zone', z.ch);
  brushBtn('Стереть зону', '#2c2c3a', 'erase', ' ');
  wrap.append(pal);

  // ── Сетка (canvas во вьюпорте с зумом/паном — как просмотрщик этажа) ──
  const CS = 24; // фикс. размер клетки в БУФЕРЕ; на экран подгоняется зумом
  const vp = document.createElement('div');
  vp.style.cssText = 'position:relative;overflow:hidden;border:1px solid #2c2c3a;border-radius:6px;background:#0d0d13;width:100%;height:460px;touch-action:none;cursor:crosshair';
  const canvas = document.createElement('canvas');
  canvas.width = prefab.w * CS; canvas.height = prefab.h * CS;
  canvas.style.cssText = 'position:absolute;left:0;top:0;image-rendering:pixelated;transform-origin:0 0';
  vp.append(canvas);
  wrap.append(vp);
  const ctx = canvas.getContext('2d')!;
  const draw = (): void => {
    for (let y = 0; y < prefab.h; y++) for (let x = 0; x < prefab.w; x++) {
      const tc = prefab.terrain[y]![x] ?? VOID;
      ctx.fillStyle = tc === VOID ? VOID_COLOR : (TERR.find((t) => t.ch === tc)?.color ?? '#cbb489');
      ctx.fillRect(x * CS, y * CS, CS, CS);
      if (tc === 'o') { ctx.fillStyle = '#0007'; ctx.beginPath(); ctx.arc(x * CS + CS / 2, y * CS + CS / 2, CS * 0.28, 0, 7); ctx.fill(); }
      const zc = prefab.zones[y]![x] ?? ' ';
      if (zc !== ' ') {
        const z = ZONE.find((q) => q.ch === zc)!;
        ctx.fillStyle = z.color; ctx.globalAlpha = 0.5; ctx.fillRect(x * CS + 1, y * CS + 1, CS - 2, CS - 2); ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff'; ctx.font = `${Math.floor(CS * 0.6)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(zc.toUpperCase(), x * CS + CS / 2, y * CS + CS / 2 + 1);
      }
    }
    ctx.strokeStyle = '#ffffff18'; ctx.lineWidth = 1;
    for (let x = 0; x <= prefab.w; x++) { ctx.beginPath(); ctx.moveTo(x * CS, 0); ctx.lineTo(x * CS, canvas.height); ctx.stroke(); }
    for (let y = 0; y <= prefab.h; y++) { ctx.beginPath(); ctx.moveTo(0, y * CS); ctx.lineTo(canvas.width, y * CS); ctx.stroke(); }
  };

  // Зум/пан (CSS-трансформ), как в floorPreview: колесо — зум к курсору, правая/средняя кнопка — пан.
  let pan = { x: 0, y: 0 }, zoom = 1;
  const applyFT = (): void => { canvas.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`; };
  requestAnimationFrame(() => {
    const w = vp.clientWidth || 600, h = vp.clientHeight || 460;
    zoom = Math.min(w / canvas.width, h / canvas.height, 3) || 1;
    pan = { x: (w - canvas.width * zoom) / 2, y: (h - canvas.height * zoom) / 2 };
    applyFT();
  });
  applyFT();

  // Курсор → КЛЕТКА с учётом зума/пана (клетка ровно там, куда нажал).
  const cellAt = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = vp.getBoundingClientRect();
    return { x: Math.floor((clientX - r.left - pan.x) / zoom / CS), y: Math.floor((clientY - r.top - pan.y) / zoom / CS) };
  };
  const paintAt = (clientX: number, clientY: number): void => {
    const { x, y } = cellAt(clientX, clientY);
    if (x < 0 || y < 0 || x >= prefab.w || y >= prefab.h) return;
    if (brush.layer === 'terrain') prefab.terrain[y] = setChar(prefab.terrain[y]!, x, brush.ch);
    else prefab.zones[y] = setChar(prefab.zones[y]!, x, brush.layer === 'erase' ? ' ' : brush.ch);
    draw();
  };
  let painting = false, panning = false, psx = 0, psy = 0, pox = 0, poy = 0;
  vp.addEventListener('pointerdown', (e) => {
    vp.setPointerCapture?.(e.pointerId);
    if (e.button === 0) { painting = true; paintAt(e.clientX, e.clientY); }
    else { panning = true; psx = e.clientX; psy = e.clientY; pox = pan.x; poy = pan.y; vp.style.cursor = 'grabbing'; }
  });
  vp.addEventListener('pointermove', (e) => {
    if (painting) paintAt(e.clientX, e.clientY);
    else if (panning) { pan.x = pox + (e.clientX - psx); pan.y = poy + (e.clientY - psy); applyFT(); }
  });
  const endGesture = (): void => { painting = false; panning = false; vp.style.cursor = 'crosshair'; };
  vp.addEventListener('pointerup', endGesture);
  vp.addEventListener('pointercancel', endGesture);
  vp.addEventListener('contextmenu', (e) => e.preventDefault()); // правая кнопка — пан, без меню
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const nz = Math.max(0.3, Math.min(8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    pan.x = mx - (mx - pan.x) * (nz / zoom); pan.y = my - (my - pan.y) * (nz / zoom); zoom = nz; applyFT();
  }, { passive: false });

  // ── Быстрые действия ──
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  const act = (label: string, fn: () => void): void => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'padding:4px 9px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:#1c1c26;color:#e8e8f0;font-size:12px'; b.addEventListener('click', () => { fn(); draw(); }); actions.append(b); };
  const eachCell = (fn: (x: number, y: number) => void): void => { for (let y = 0; y < prefab.h; y++) for (let x = 0; x < prefab.w; x++) fn(x, y); };
  act('Залить полом', () => eachCell((x, y) => { prefab.terrain[y] = setChar(prefab.terrain[y]!, x, '.'); }));
  act('Рамка-стена', () => eachCell((x, y) => { if (x === 0 || y === 0 || x === prefab.w - 1 || y === prefab.h - 1) prefab.terrain[y] = setChar(prefab.terrain[y]!, x, '#'); }));
  act('Очистить зоны', () => eachCell((x, y) => { prefab.zones[y] = setChar(prefab.zones[y]!, x, ' '); }));
  act('⤢ По размеру', () => { const w = vp.clientWidth || 600, h = vp.clientHeight || 460; zoom = Math.min(w / canvas.width, h / canvas.height, 3) || 1; pan = { x: (w - canvas.width * zoom) / 2, y: (h - canvas.height * zoom) / 2 }; applyFT(); });
  // Поворот/зеркало — структурные (меняют w/h), поэтому полный re-render через onStructural.
  const structBtn = (label: string, fn: () => void): void => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'padding:4px 9px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:#22222e;color:#e8e8f0;font-size:12px'; b.addEventListener('click', () => { fn(); onStructural(); }); actions.append(b); };
  structBtn('↻ Повернуть 90°', () => { const q = rotatePrefabCW(prefab); prefab.w = q.w; prefab.h = q.h; prefab.terrain = q.terrain; prefab.zones = q.zones; });
  structBtn('⇋ Отразить', () => { const q = mirrorPrefab(prefab); prefab.terrain = q.terrain; prefab.zones = q.zones; });
  structBtn('✂ Обрезать по рисунку', () => { const t = trimPrefab(prefab); prefab.terrain = t.terrain; prefab.zones = t.zones; prefab.w = t.w; prefab.h = t.h; }); // размер = габариты нарисованного
  wrap.append(actions);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:#71718a';
  hint.textContent = 'ЛКМ — рисовать (тяни с зажатой), ПКМ/средняя — двигать, колесо — зум. Форма ЛЮБАЯ: рисуй пол/стены поверх пустоты, «Пусто» стирает клетку (вне комнаты). «✂ Обрезать по рисунку» = размер из нарисованного. Дверь (+) — стык с коридором. Зоны — куда генератор ставит контент. Не забудь «Применить».';
  wrap.append(hint);

  refreshBrush();
  draw();
  return wrap;
}
