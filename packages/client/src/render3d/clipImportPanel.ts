/**
 * ПАНЕЛЬ ИМПОРТА КЛИПА — рабочее место «мокап → наш клип».
 *
 * Было: модалка из шести полей, `body: full|upper|lower` одним селектом, диагностика только в F12, обрезать
 * длинный мокап нечем, а результат виден ТОЛЬКО после того, как он уже лёг в библиотеку.
 *
 * Стало: маска по частям тела (пикер — по манекену тоже, см. `togglePartOfBone`), базовая поза (base layer),
 * обрезка по исходнику, таз/заземление/голова, карта костей, отчёт как ДАННЫЕ — и всё это с ЖИВЫМ ПРЕВЬЮ:
 * каждое переключение пере-запекает клип и сразу показывает его в вьюпорте, до коммита в библиотеку.
 *
 * Живое превью возможно только потому, что `clipBaker` разделён на `openBakeSource` (тяжёлое: парс+карта+T-поза,
 * ОДИН раз на файл) и `bakeFromSource` (лёгкое: семпл+прореживание). Иначе каждая галка перепарсивала бы FBX.
 *
 * Модуль ЗАМКНУТ на колбэки: он не знает ни про библиотеку клипов, ни про сервер, ни про сцену.
 */
import type * as THREE from 'three';
import { openBakeSource, bakeFromSource, logSourceReport, type BakeSource, type BakeOptions, type BakeResult } from './clipBaker.js';
import { isStaticBake, loopSeamGap } from './clipImport.js';
import { matchMocapSet, type MocapTake } from './mocapSetMap.js';   // ⭐ таблица «тейк → наш клип» для переноса набора
import { MASK_PARTS, MASK_PRESETS, presetMask, togglePart, setPartWeight, partWeight, maskLabel, PART_OF_BONE, type BoneMask, type MaskPart } from './boneMask.js';
import { clampClip, clampSummary } from './clipClamp.js';   // ⭐ пределы суставов на импорте, по выбранным частям
import { limitViewForBone } from './humanoidRagdoll.js';
import { LIMBS } from './footLock.js';
import { OUR_BONES } from './retarget3d.js';
import type { Clip, Pose } from './clipModel.js';

const css = {
  input: 'box-sizing:border-box;padding:2px 5px;background:#0f1119;color:#dfe3ee;border:1px solid #39415a;border-radius:4px;font:11px monospace',
  chip: 'padding:3px 7px;background:#232838;color:#7b8399;border:1px solid #39415a;border-radius:10px;cursor:pointer;font:11px monospace',
  chipOn: 'padding:3px 7px;background:#2f4a35;color:#cfe8cf;border:1px solid #587a5e;border-radius:10px;cursor:pointer;font:11px monospace',
  btn: 'margin:0 3px 0 0;padding:3px 9px;background:#2a3350;color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace',
};
const el = (tag: string, style = '', text = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = style; if (text) e.textContent = text; return e; };
const btn = (label: string, fn: () => void): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = css.btn; b.onclick = fn; return b; };
function sel<T extends string>(opts: [T, string][], value: T, on: (v: T) => void): HTMLSelectElement {
  const s = document.createElement('select'); s.style.cssText = css.input + ';flex:2';
  for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); }
  s.value = value; s.onchange = () => on(s.value as T); return s;
}
function check(on: boolean, fn: (v: boolean) => void): HTMLInputElement {
  const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on; c.onchange = () => fn(c.checked); return c;
}
/** Ползунок 0..1 с процентами справа — «сила» встречается в панели трижды. */
function pct(value: number, fn: (v: number) => void): HTMLElement[] {
  const sl = document.createElement('input'); sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.05';
  sl.value = String(value); sl.style.flex = '2';
  const v = el('span', 'width:36px;text-align:right;font-size:10px;color:#c8b06a'); v.textContent = Math.round(value * 100) + '%';
  sl.oninput = () => { const x = parseFloat(sl.value); v.textContent = Math.round(x * 100) + '%'; fn(x); };
  return [sl, v];
}
function num(value: number, step: number, fn: (v: number) => void, width = 62): HTMLInputElement {
  const i = document.createElement('input'); i.type = 'number'; i.step = String(step); i.value = String(value);
  i.style.cssText = css.input + `;width:${width}px`; i.oninput = () => fn(parseFloat(i.value)); return i;
}

export interface ImportPanelCallbacks {
  /** Подпись «кому и с чем» (персонаж · оружие). */
  title: string;
  /** Кандидаты в БАЗОВУЮ ПОЗУ (base layer Unity): обычный idle, боевой idle, любой клип. */
  basePoses(): { id: string; label: string; pose: Pose }[];
  /** Показать превью-клип в вьюпорте (null — убрать). Клип НЕ должен попадать в библиотеку/на сервер. */
  preview(clip: Clip | null): void;
  /** Принять клип. Панель закрывается сама. */
  commit(clip: Clip): void;
  /**
   * Принять ПАЧКУ клипов одним действием (перенос набора мокапа). Возвращает ИМЕНА, под которыми клипы
   * реально легли: импорт никогда не затирает, поэтому занятое имя превращается в `walk_fwd_2` — и
   * молча этого оставлять нельзя, иначе повторный перенос тихо копит дубли. Панель НЕ закрывается:
   * ядро и дополнительное содержимое переносятся двумя нажатиями.
   * Нет колбэка → блок переноса не показывается вовсе.
   */
  commitMany?(clips: Clip[]): string[];
  /** Ручная карта костей, сохранённая под сигнатурой рига (Ф4) — следующий файл того же пакета подхватит её. */
  loadBoneMap?(sig: string): Record<string, string> | undefined;
  saveBoneMap?(sig: string, map: Record<string, string>): void;
  /** Пуск/стоп проигрывания превью — кнопка дублируется в панели, чтобы её не искать в основном таймлайне. */
  togglePlay?(): void;
  isPlaying?(): boolean;
}
export interface ImportPanel {
  /** Клик по кости манекена во вьюпорте — переключить ЧАСТЬ, которой она принадлежит (пикер по телу). */
  togglePartOfBone(bone: string): boolean;
  close(): void;
}

export function openClipImportPanel(file: File, cb: ImportPanelCallbacks): ImportPanel {
  // ⚠ НЕ МОДАЛКА. Панель настраивает то, что надо СМОТРЕТЬ, а модалка на весь экран с затемнением
  // физически закрывает вьюпорт: все галки есть, а результата не видно. Поэтому — колонка СЛЕВА
  // (основная панель редактора справа), без затемнения и без перехвата кликов мимо себя: по манекену
  // надо кликать прямо во время настройки (пикер маски по костям).
  // ГЕОМЕТРИЯ БЕРЁТСЯ С КАНВАСА ВЬЮПОРТА, а не из чисел: вёрстка редактора флексовая, высота нижнего блока
  // (тайм-лайн) плавает — с фиксированным `bottom` панель на него наезжала. Канвас и есть та область,
  // которую панель имеет право закрывать, поэтому к ней и привязываемся.
  const ov = el('div', 'position:fixed;z-index:99999;display:flex;pointer-events:none');
  const box = el('div', 'pointer-events:auto;flex:1;background:#141824;border:1px solid #39415a;border-radius:8px;padding:12px;overflow:auto;font:12px monospace;color:#dfe3ee;box-shadow:0 8px 32px rgba(0,0,0,.5)');
  ov.append(box); document.body.append(ov);
  const view = document.querySelector('canvas');
  const place = (): void => {
    const r = view?.getBoundingClientRect();
    const top = r ? r.top + 6 : 46, hgt = r ? Math.max(120, r.height - 12) : innerHeight - 54;
    ov.style.cssText += `;left:${(r?.left ?? 0) + 8}px;top:${top}px;height:${hgt}px;width:430px`;
  };
  place();
  // ⚠ Пересчитывать НА СЛЕДУЮЩЕМ КАДРЕ. И `resize`-слушатель, и ResizeObserver срабатывают в общей очереди
  // с раскладкой самого редактора: замер показал, что при синхронном вызове панель читает ЕЩЁ СТАРЫЙ размер
  // канваса и остаётся висеть на прежней высоте (окно 1280→1024: канвас стал 66..492, панель осталась 72..566).
  const schedule = (): void => { requestAnimationFrame(place); };
  const ro = view ? new ResizeObserver(schedule) : null;
  if (view && ro) ro.observe(view);
  addEventListener('resize', schedule);
  const row = (label: string, hint = ''): HTMLElement => {
    const r = el('label', 'display:flex;align-items:center;gap:8px;margin:5px 0');
    const s = el('span', 'flex:1;color:#9aa3b8'); s.textContent = label; if (hint) r.title = hint;
    r.append(s); box.append(r); return r;
  };
  const head = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:6px'); head.textContent = '📥 Импорт анимации: ' + file.name; box.append(head);
  const sub = el('div', 'color:#6b7180;font-size:10px;margin-bottom:6px'); sub.textContent = cb.title; box.append(sub);

  // ── ПРЕВЬЮ: каждая правка сразу проигрывается в вьюпорте, кнопка тут же ──
  const playRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 6px;padding:5px;background:#171b26;border-radius:4px');
  const playBtn = btn('⏸', () => { cb.togglePlay?.(); syncPlay(); });
  const playHint = el('div', 'flex:1;color:#9ae6a0;font-size:10px');
  playHint.textContent = 'превью играет в вьюпорте — каждая правка пере-запекает клип';
  const syncPlay = (): void => { playBtn.textContent = cb.isPlaying?.() ? '⏸' : '▶'; };
  playRow.append(playBtn, playHint); box.append(playRow);

  // ── состояние ──
  let src: BakeSource | null = null;
  let mask: BoneMask = presetMask('noFingers');
  let baseId = '';
  const o: BakeOptions & { character: string; weapon: string } = {
    character: '', weapon: '', animationIndex: 0, fps: 30, epsDeg: 3,
    hips: 'full', ground: false, head: 'mocap', headPitch: 0, anchorIdle: true,
    limbLock: { LF: true, RF: true },
  };
  let last: BakeResult | null = null;
  let closed = false;

  const status = el('div', 'color:#c8b06a;font-size:11px;margin:6px 0 2px;min-height:14px');
  const diag = el('div', 'font-size:10px;color:#8a93a8;line-height:1.5;background:#0f1119;border:1px solid #2a3040;border-radius:4px;padding:6px;margin:4px 0;white-space:pre-wrap');

  // ── анимация / детализация ──
  const animSel = document.createElement('select'); animSel.style.cssText = css.input + ';flex:2';
  animSel.onchange = () => { o.animationIndex = parseInt(animSel.value, 10) || 0; o.startSec = undefined; o.endSec = undefined; syncTrim(); rebake(); };
  row('анимация').append(animSel);

  const trimRow = row('обрезка (сек)', 'Режем ПО ИСХОДНИКУ: прореживание идёт уже по обрезанному, поэтому концы ложатся ровно на границы.');
  const trimA = num(0, 0.05, (v) => { o.startSec = v; rebake(); });
  const trimB = num(0, 0.05, (v) => { o.endSec = v; rebake(); });
  const trimAll = btn('всё', () => { o.startSec = undefined; o.endSec = undefined; syncTrim(); rebake(); });
  trimRow.append(trimA, el('span', 'color:#6b7180', '→'), trimB, trimAll);
  const syncTrim = (): void => {
    const d = src?.animations[o.animationIndex ?? 0]?.duration ?? 0;
    trimA.value = String(+(o.startSec ?? 0).toFixed(2)); trimB.value = String(+(o.endSec ?? d).toFixed(2));
  };

  row('семпл fps').append(num(30, 1, (v) => { o.fps = v || 30; rebake(); }));
  const epsVal = el('span', 'color:#c8b06a;min-width:70px;text-align:right');
  const epsIn = document.createElement('input'); epsIn.type = 'range'; epsIn.min = '0'; epsIn.max = '50'; epsIn.step = '0.5'; epsIn.value = '3'; epsIn.style.flex = '2';
  epsIn.oninput = () => { o.epsDeg = parseFloat(epsIn.value); epsVal.textContent = o.epsDeg === 0 ? 'все кадры' : o.epsDeg.toFixed(1) + '°'; rebake(); };
  epsVal.textContent = '3.0°';
  row('детализация', 'Порог прореживания: кадр остаётся, только если без него интерполяция ошибётся больше этого угла.').append(epsIn, epsVal);

  const loopChk = check(false, (v) => { o.loop = v; rebake(); });
  row('зациклить').append(loopChk);

  // ⭐⭐ НАБОР ХОДА. Без этой галки мокап-ход попадает в набор ЛЕГАСИ: часы читают ему скорость долями
  // по имени (50.4 / 102 u/с), а не ту, на которой его сняли. Скорость меряется по травелу источника
  // и печатается в строке итога всегда — по ней сразу видно, ходьба это или бег.
  row('клип набора хода', 'Дописать метаданные набора: скорость съёма (замер по травелу), ревизию, нейтраль маха и «чистый верх». Оружие при этом обязано быть «нет» — набор хода снят безоружным.')
    .append(check(false, (v) => { o.locoSet = v; rebake(); }));

  // ── МАСКА: части тела ──
  const mh = el('div', 'color:#8fb7ff;font-weight:bold;margin:10px 0 2px;font-size:11px'); mh.textContent = 'ЧТО БЕРЁМ ИЗ МОКАПА'; box.append(mh);
  const mHint = el('div', 'color:#6b7180;font-size:10px;margin-bottom:4px');
  mHint.textContent = 'Вес = сколько взять из мокапа: 1 — мокап, 0 — базовая поза, между — смесь. Клик по подписи (или по кости манекена) переключает 0↔1.';
  box.append(mHint);
  const preRow = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px'); box.append(preRow);
  for (const p of MASK_PRESETS) preRow.append(btn(p.label, () => { mask = presetMask(p.id); drawMask(); rebake(); }));
  // Сетка «часть · ползунок · %» — так же показан Blend Mask в дереве скелета UE (кость + колонка веса).
  // Чипами тут не обойтись: вес это непрерывная величина, а не два состояния.
  const grid = el('div', 'margin-top:2px'); box.append(grid);
  const rows = new Map<MaskPart, { chip: HTMLElement; sl: HTMLInputElement; val: HTMLElement }>();
  for (const p of MASK_PARTS) {
    const r = el('div', 'display:flex;align-items:center;gap:6px;margin:1px 0');
    const chip = el('span', css.chip, p.label); chip.style.cssText += ';min-width:74px;text-align:center';
    chip.onclick = () => { mask = togglePart(mask, p.id); drawMask(); rebake(); };
    const sl = document.createElement('input'); sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.05'; sl.style.flex = '1';
    sl.oninput = () => { mask = setPartWeight(mask, p.id, parseFloat(sl.value)); drawMask(); rebake(); };
    const val = el('span', 'width:34px;text-align:right;font-size:10px;color:#c8b06a');
    r.append(chip, sl, val); grid.append(r);
    rows.set(p.id, { chip, sl, val });
  }
  const maskNote = el('div', 'color:#6b7180;font-size:10px;margin:3px 0'); box.append(maskNote);

  // ⭐⭐ ПРЕДЕЛЫ СУСТАВОВ НА ИМПОРТЕ — ПО ЧАСТЯМ.
  //
  // Жалоба «на ударе мечом голову ведёт в сторону»: клип авторил шею −52° и голову −38° (вместе ~90°)
  // при пределе головы ±40°, и НИКТО этого не проверял — редактор клампит только ручной позинг.
  //
  // ⚠ Галки, а не «зажать всё»: предел настроен под физику и ручную правку, и на руках-ногах он
  // вполне может испортить мокап. Части — те же, что у маски: два разных списка тела в одной панели
  // читались бы как разные вещи.
  //
  // ⚠ Умолчание — только ГОЛОВА (шея+голова): это единственное место, где перебор уже пойман
  // замером. Остальное включается осознанно и смотрится глазами.
  let clampParts: MaskPart[] = ['head'];
  const clampBox = el('div', 'margin:4px 0 2px'); box.append(clampBox);
  const clampHint = el('div', 'color:#6b7180;font-size:10px;margin-bottom:2px',
    'Зажать пределами суставов (мокап может выходить за анатомию — например шея на замахе).');
  clampBox.append(clampHint);
  const clampRow = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); clampBox.append(clampRow);
  const clampChips = new Map<MaskPart, HTMLElement>();
  for (const p of MASK_PARTS) {
    const chip = el('span', css.chip, p.label); chip.style.cssText += ';min-width:64px;text-align:center';
    chip.onclick = () => {
      clampParts = clampParts.includes(p.id) ? clampParts.filter((x) => x !== p.id) : [...clampParts, p.id];
      drawClamp(); rebake();
    };
    clampChips.set(p.id, chip); clampRow.append(chip);
  }
  const clampNote = el('div', 'color:#6b7180;font-size:10px;margin:3px 0'); clampBox.append(clampNote);
  let clampText = '';
  const drawClamp = (): void => {
    for (const [id, chip] of clampChips) {
      chip.style.cssText = (clampParts.includes(id) ? css.chipOn : css.chip) + ';min-width:64px;text-align:center';
    }
    clampNote.textContent = clampParts.length ? `пределы: ${clampParts.length} част(ей) · ${clampText}` : 'пределы не применяются';
  };
  const drawMask = (): void => {
    for (const [id, r] of rows) {
      const w = partWeight(mask, id);
      r.chip.style.cssText = (w > 0 ? css.chipOn : css.chip) + ';min-width:74px;text-align:center';
      r.sl.value = String(w);
      r.val.textContent = Math.round(w * 100) + '%';
    }
    maskNote.textContent = 'маска: ' + maskLabel(mask);
  };

  const baseSel = document.createElement('select'); baseSel.style.cssText = css.input + ';flex:2';
  baseSel.onchange = () => { baseId = baseSel.value; rebake(); };
  row('базовая поза', 'Чем заполняется НЕ взятое маской (в Unity это нижний слой, в Unreal — референс-поза).').append(baseSel);
  const anchorChk = check(true, (v) => { o.anchorIdle = v; rebake(); });
  row('старт/финиш из базовой позы', 'Клип idle→движение→idle: первый и последний ключ = стойка, вход и выход бесшовные.').append(anchorChk);

  // ── таз / заземление / голова ──
  const bh = el('div', 'color:#8fb7ff;font-weight:bold;margin:10px 0 2px;font-size:11px'); bh.textContent = 'ТЕЛО'; box.append(bh);
  row('таз: смещение', 'Это СМЕЩЕНИЕ таза — отдельный канал, не часть маски (строка «таз» в сетке выше — это ПОВОРОТ таза). Травел вычитается по ОПОРНОЙ стопе, поэтому бег, который едет вперёд, не протекает в клип.')
    .append(sel<'none' | 'vertical' | 'full'>([['full', 'вертикаль + перенос веса'], ['vertical', 'только вертикаль'], ['none', 'не брать']], 'full', (v) => { o.hips = v; rebake(); }));
  row('сила переноса веса', '1 = таз ездит как в мокапе, 0 = стоит. Работает и с маской «верх»: ноги при этом берутся из базовой позы, а держит их опора стоп.')
    .append(...pct(1, (v) => { o.hipsWeight = v; rebake(); }));
  // ОПОРА — те же четыре пина, что в редакторе («ПИНЫ (закрепить точку)»), чтобы это было одно понятие,
  // а не два похожих. Дефолт как у эффекторов редактора: стопы держим, кисти нет.
  const lockRow = row('опора (пины)', 'Конец держится на месте, пока корпус живёт своей жизнью: конечность догибается. Синие ручки в вьюпорте — кисти, зелёные — стопы. Понижаешь вес руки — включи её пин, тогда кисть будет держаться за ручку, а не уезжать со скруткой корпуса.');
  for (const L of LIMBS) {
    const lab = el('label', 'display:flex;align-items:center;gap:2px;font-size:10px;color:#9aa3b8');
    lab.append(check(!!o.limbLock?.[L.id], (v) => { o.limbLock = { ...o.limbLock, [L.id]: v }; rebake(); }), document.createTextNode(L.label));
    lockRow.append(lab);
  }
  row('сила привязки', 'Reach из HumanIK: 1 = держится намертво, 0 = едет за телом, между — на полпути. Тот же смысл, что у ползунка в редакторе.')
    .append(...pct(1, (v) => { o.lockWeight = v; rebake(); }));
  row('заземление', 'ВЫКЛЮЧЕНО по умолчанию: мокап уже заземлён, а покадровый лифт таза ломает вертикаль — на беге исчезает ФАЗА ПОЛЁТА целиком (замер: 42.6 % кадров в воздухе → 0.0 %), на ходьбе вертикаль таза раздувается на 26–33 %, щелчок стопы растёт до +72 %. Контакт с полом делает рантайм каждый кадр. Включай, только если источник действительно висит или тонет.')
    .append(check(false, (v) => { o.ground = v; rebake(); }));
  // ── КОРЕНЬ (Ф2). Две галки, и обе по умолчанию ВЫКЛЮЧЕНЫ. ──
  // Клип остаётся in-place при любой из них: позицию и фейсинг задаёт сервер, и в игре эти каналы не
  // читает никто. Снимаем их не ради движения, а ради анализатора (длина шага, угол поворота за шаг)
  // и экспорта в чужой движок, где это и есть root motion.
  row('корень: смещение', 'Записать перемещение персонажа за клип отдельным каналом `__rootP`. Клип ОСТАЁТСЯ на месте — канал нужен анализатору походки и экспорту. Это ровно тот травел, который и так вычитается.')
    .append(check(false, (v) => { o.rootPos = v; rebake(); }));
  row('корень: поворот', 'Записать поворот персонажа за клип в `__rootY` и ВЫЧЕСТЬ его из кости таза — так клип поворота (45/90/180) становится in-place, а угол сохраняется числом для анализатора.')
    .append(check(false, (v) => { o.rootYaw = v; rebake(); }));
  const headRow = row('голова', '«На прицел» запекает голову фиксированной вперёд: гасит и мокап-болтанку, и нырок от свинга корпуса. В клиенте останется только доворот на курсор.');
  headRow.append(sel<'mocap' | 'aim' | 'none'>([['mocap', 'из мокапа'], ['aim', 'зафиксировать на прицел'], ['none', 'не брать']], 'mocap', (v) => { o.head = v; drawMask(); rebake(); }));
  const pitchRow = row('кивок головы (°)');
  pitchRow.append(num(0, 1, (v) => { o.headPitch = (v || 0) * Math.PI / 180; rebake(); }));

  // ── карта костей ──
  const mapWrap = el('details', 'margin:8px 0');
  const mapSum = document.createElement('summary'); mapSum.style.cssText = 'cursor:pointer;color:#8fb7ff;font-size:11px'; mapSum.textContent = 'карта костей';
  mapWrap.append(mapSum); box.append(mapWrap);
  const mapBody = el('div', 'max-height:190px;overflow:auto;margin-top:4px'); mapWrap.append(mapBody);

  // ── ПЕРЕНОС НАБОРА МОКАПА (появляется, только если в файле нашлись тейки из таблицы) ──
  const setWrap = el('div', 'margin:10px 0;padding:7px;background:#121a14;border:1px solid #33513c;border-radius:5px;display:none');
  const setHead = el('div', 'color:#9ae6a0;font-weight:bold;font-size:11px;margin-bottom:3px');
  const setBody = el('div', 'font-size:10px;color:#8a93a8;line-height:1.5;white-space:pre-wrap;max-height:150px;overflow:auto');
  const setBtns = el('div', 'display:flex;gap:6px;margin-top:5px;flex-wrap:wrap');
  setWrap.append(setHead, setBody, setBtns); box.append(setWrap);

  box.append(diag, status);
  const btns = el('div', 'display:flex;gap:6px;margin-top:6px;justify-content:flex-end'); box.append(btns);
  const takeBtn = btn('взять', () => {
    if (!last) return;
    cb.preview(null);
    cb.commit(last.clip);
    close();
  });
  btns.append(btn('отмена', () => close()), takeBtn);
  takeBtn.disabled = true;

  function close(): void {
    if (closed) return;
    closed = true;
    ro?.disconnect(); removeEventListener('resize', schedule);
    cb.preview(null);
    ov.remove();
  }

  // ── запекание ──
  let timer: ReturnType<typeof setTimeout> | null = null;
  function rebake(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(doBake, 40);          // склеиваем пачку изменений (ползунок детализации шлёт их потоком)
  }
  function doBake(): void {
    if (!src || closed) return;
    const base = cb.basePoses().find((b) => b.id === baseId)?.pose;
    try {
      last = bakeFromSource(src, { ...o, mask, basePose: base });
      // ⭐ ЗАПОМИНАЕМ, К ЧЕМУ ПРИВЯЗАНЫ КОНЦЫ. Иначе синк концов в редакторе возьмёт обычную стойку,
      // и выбор «боевая» потеряется ровно на сохранении (жалоба: «сохраняется с другой стойкой»).
      if (last.clip.idleEnds) last.clip.idleEndsFrom = baseId;
      // ⭐ ПРЕДЕЛЫ — ПОСЛЕ запекания и ДО превью: глазами надо видеть уже зажатый результат, иначе
      // настраивать нечего. Отчёт показываем рядом с галками, потому что правка молча меняет
      // авторскую работу и её не с чем было бы сопоставить.
      clampText = clampSummary(clampClip(last.clip, clampParts, limitViewForBone));
      drawClamp();
      cb.preview(last.clip);
      syncPlay();
      takeBtn.disabled = false;
      const s = last.stats;
      const seam = last.clip.loop ? loopSeamGap(last.clip) : null;
      const hr = s.hipsRange;
      status.textContent = `${s.frames} кадров → ${s.keys} ключей · движение ${s.maxMoveDeg.toFixed(1)}° (${s.worstBone})`
        + (hr ? ` · таз ${hr[0]}/${hr[1]}/${hr[2]}` : '')
        + (seam ? ` · шов цикла ${seam.deg.toFixed(1)}°` : '')
        // Скорость съёма — в u/с И в м/с: наши числа (ходьба 40, бег 120) в юнитах, а мокап автор знает в м/с.
        + ((s.locoSpeed ?? 0) >= 1 ? ` · съём ${s.locoSpeed!.toFixed(1)} u/с (${(s.locoSpeed! / 32).toFixed(2)} м/с)` : '');
      status.style.color = isStaticBake(s) ? '#e08080' : '#9ae6a0';
      if (isStaticBake(s)) status.textContent += ' ← СТАТИЧНО: анимация не дошла до костей, проверь карту костей';
      // Срыв опоры — единственный способ увидеть, что «перенос веса» упёрся в длину ноги, а не работает.
      if ((s.footMiss ?? 0) > 0.5) { status.style.color = '#e0b060'; status.textContent += ` ← перенос веса упёрся в длину ноги (стопа сорвана на ${s.footMiss!.toFixed(1)})`; }
      // Набор хода просили, а руки пришли не из мокапа → флага «чистый верх» нет, и стойка ляжет в руки дважды.
      if (s.upperDirty) { status.style.color = '#e0b060'; status.textContent += ' ← руки НЕ из мокапа: «чистый верх» не проставлен, аудит покажет «стойка в руках»'; }
      // Режим набора включён, а источник стоит на месте — метаданные не пишутся, и это надо видеть сразу.
      if (o.locoSet && (s.locoSpeed ?? 0) < 1) { status.style.color = '#e0b060'; status.textContent += ' ← источник НЕ едет: скорость съёма не замерить, метаданные набора не записаны'; }
    } catch (e) {
      takeBtn.disabled = true; status.style.color = '#e08080'; status.textContent = 'ошибка: ' + (e as Error).message;
    }
  }

  /**
   * ПЕРЕНОС НАБОРА ОДНИМ ПРОХОДОМ. Ядро (имена, которые спрашивает движок) и дополнительное содержимое —
   * двумя кнопками, потому что это разные решения: первое меняет картинку, второе кладёт материал на будущее.
   *
   * ⚠ Пакет НЕ берёт настройки «зациклить» и «якорь idle» из панели: цикличность у каждого тейка СВОЯ
   * (`MocapTake.cyclic`), а якорь idle подставил бы стойку первым и последним кадром — цикл ходьбы от этого
   * перестал бы сходиться. Семпл берём 60 fps: у тейков Kubold шаг кадров разный (30/60 и неровный), и на
   * 30 ход теряет фазу постановки. Всё остальное (маска, базовая поза, таз, заземление, голова) — как в панели.
   */
  function batchTake(t: MocapTake, bakeId: number): Clip | string {
    const i = src!.animations.findIndex((a) => a.name === t.take);
    if (i < 0) return `${t.clip}: тейка «${t.take}» в файле нет`;
    const dur = src!.animations[i]!.duration;
    try {
      const r = bakeFromSource(src!, {
        ...o, animationIndex: i, name: t.clip, loop: t.cyclic, locoSet: true, bakeId,
        anchorIdle: false, fps: 60,
        // ⚠ БЕЗ ПИНОВ СТОП: у мокапа стопы уже верны, а холостой прогон солвера ломает ногу на бегу
        // (голень ложится вдоль полюса — замер 3.1°, мировой скачок голени 179°). См. `mocapSetMap.ts`.
        limbLock: { LF: false, RF: false },
        rootYaw: t.rootYaw ?? false, yawFromFeet: t.yawFromFeet ?? false, rootPos: true,
        startSec: t.trim ? t.trim[0] * dur : undefined,
        endSec: t.trim ? t.trim[1] * dur : undefined,
      });
      // Статичный результат — это карта костей или дубль скелета, а не «такой тейк». В набор такое не кладём.
      if (isStaticBake(r.stats)) return `${t.clip}: СТАТИКА (движение ${r.stats.maxMoveDeg.toFixed(1)}°) — проверь карту костей`;
      return r.clip;
    } catch (e) { return `${t.clip}: ${(e as Error).message}`; }
  }

  function runBatch(list: readonly MocapTake[], what: string): void {
    if (!src || !cb.commitMany || !list.length) return;
    const bakeId = Date.now();               // один номер съёма на весь проход — по нему аудит видит, что клипы вместе
    const clips: Clip[] = [], bad: string[] = [];
    for (const t of list) { const r = batchTake(t, bakeId); if (typeof r === 'string') bad.push(r); else clips.push(r); }
    const names = clips.length ? cb.commitMany(clips) : [];
    const renamed = names.filter((n, i) => n !== clips[i]!.name).map((n, i) => `${clips[i]!.name} → ${n}`);
    cb.preview(null);
    status.style.color = bad.length || renamed.length ? '#e0b060' : '#9ae6a0';
    status.textContent = `перенесено ${what}: ${clips.length}`
      + (renamed.length ? `\n⚠ имена были заняты (импорт не затирает): ${renamed.join(', ')}` : '')
      + (bad.length ? `\n⚠ не взято: ${bad.join('; ')}` : '');
  }

  function drawMocapSet(): void {
    if (!src || !cb.commitMany) return;
    const m = matchMocapSet(src.animations.map((a) => a.name));
    if (!m.core.length && !m.extra.length && !m.blocked.length) return;
    setWrap.style.display = '';
    setHead.textContent = `НАБОР МОКАПА В ЭТОМ ФАЙЛЕ: ядро ${m.core.length}, дополнительно ${m.extra.length}`
      + (m.blocked.length ? `, нельзя ${m.blocked.length}` : '');
    const lines: string[] = [];
    for (const t of m.core) lines.push(`  ${t.take} → ${t.clip}  — ${t.note}`);
    for (const t of m.blocked) lines.push(`  ⛔ ${t.take} → ${t.clip}  — ${t.blocked!}`);
    if (m.absentCore.length) lines.push(`  ядра нет в этом файле (лежит в других файлах пакета): ${m.absentCore.join(', ')}`);
    if (m.extra.length) lines.push(`  + дополнительно: ${m.extra.map((t) => t.clip).join(', ')}`);
    lines.push('  пакет берётся на 60 fps, циклы по своей таблице, якорь idle выключен; остальное — как настроено выше');
    setBody.textContent = lines.join('\n');
    setBtns.innerHTML = '';
    if (m.core.length) setBtns.append(btn(`перенести ядро (${m.core.length})`, () => runBatch(m.core, 'ядро')));
    if (m.extra.length) setBtns.append(btn(`перенести дополнительно (${m.extra.length})`, () => runBatch(m.extra, 'дополнительно')));
  }

  function drawDiag(): void {
    if (!src) return;
    const r = src.report;
    const lines = [
      `костей ${r.bones}${r.dupNames.length ? `  ⚠ дубли имён: ${r.dupNames.length}` : ''}   риг ${src.signature}`,
      `смаплено ${r.mapped.length}/${OUR_BONES.length}${r.unmapped.length ? '  ⚠ нет: ' + r.unmapped.join(', ') : ''}   пальцы ${r.fingers}/30`,
      `rest до/после T-позы:  рука ${r.restBefore.arm} → ${r.restAfter.arm}   нога ${r.restBefore.leg} → ${r.restAfter.leg}`,
    ];
    diag.textContent = lines.join('\n');
  }

  function drawMapTable(): void {
    if (!src) return;
    mapBody.innerHTML = '';
    // Кандидаты — только УЗЛЫ СКЕЛЕТА. Меши в список не берём: на нашем же экспорте их 44 штуки
    // (`mesh_0`…`mesh_43`), и они топят 22 реальные кости. Фильтруем по типу, а не по имени.
    const names: string[] = [];
    src.loaded.traverse((n) => {
      const m = n as THREE.Mesh;
      if (n.name && !m.isMesh) names.push(n.name);
    });
    const uniq = [...new Set(names)].sort();
    for (const our of OUR_BONES) {
      const r = el('div', 'display:flex;align-items:center;gap:6px;margin:1px 0');
      const l = el('span', `flex:1;font-size:10px;color:${src!.boneMap[our] ? '#9aa3b8' : '#e08080'}`, our);
      const s = document.createElement('select'); s.style.cssText = css.input + ';flex:2;font-size:10px';
      const none = document.createElement('option'); none.value = ''; none.textContent = '— нет —'; s.append(none);
      for (const n of uniq) { const op = document.createElement('option'); op.value = n; op.textContent = n; s.append(op); }
      s.value = src!.boneMap[our] ?? '';
      s.onchange = () => { void remap(our, s.value); };
      r.append(l, s); mapBody.append(r);
    }
  }
  /** Смена кости в карте = ДРУГОЙ обратный ретаргет → источник надо открыть заново (restW снимается на bind). */
  async function remap(our: string, target: string): Promise<void> {
    if (!src) return;
    const map = { ...src.boneMap };
    if (target) map[our] = target; else delete map[our];
    status.style.color = '#c8b06a'; status.textContent = 'пересобираю карту…';
    src = await openBakeSource(file, map);
    cb.saveBoneMap?.(src.signature, src.boneMap);
    drawDiag(); drawMapTable(); drawMocapSet(); doBake();
  }

  // ── старт ──
  void (async () => {
    status.textContent = 'читаю файл…';
    try {
      const probe = await openBakeSource(file);
      src = cb.loadBoneMap?.(probe.signature) ? await openBakeSource(file, cb.loadBoneMap(probe.signature)) : probe;
      if (closed) return;
      logSourceReport(src);
      animSel.innerHTML = '';
      src.report.animations.forEach((a, i) => { const op = document.createElement('option'); op.value = String(i); op.textContent = `${a.name}  (${a.dur.toFixed(2)}s)`; animSel.append(op); });
      const first = src.report.animations[0]?.name ?? '';
      if (/walk|run|idle|ход|бег|цикл|loop/i.test(first)) { loopChk.checked = true; o.loop = true; }
      const bases = cb.basePoses();
      for (const b of bases) { const op = document.createElement('option'); op.value = b.id; op.textContent = b.label; baseSel.append(op); }
      baseId = bases[0]?.id ?? ''; baseSel.value = baseId;
      syncTrim(); drawMask(); drawClamp(); drawDiag(); drawMapTable(); drawMocapSet(); doBake();
    } catch (e) {
      status.style.color = '#e08080'; status.textContent = 'ошибка чтения: ' + (e as Error).message;
    }
  })();

  return {
    togglePartOfBone(bone: string): boolean {
      const part = PART_OF_BONE[bone];
      if (!part || closed) return false;
      mask = togglePart(mask, part); drawMask(); rebake();
      return true;
    },
    close,
  };
}
