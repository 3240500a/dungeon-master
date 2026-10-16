/**
 * ⭐ 16.10 (Артбук): подвкладка «🧙 Персонажи». Семь классов из конфига (`data.classes`) в порядке брифа → страница класса:
 * концепты (слоты), описание (сид `classes.json` по `docs/GAME_BRIEF.txt` §4, правится на месте) и ЖИВЫЕ ЧИСЛА тем же кодом,
 * что игра (`classNumbers.ts`: стартовые атрибуты, жизнь/мана/выносливость на 1-м и выбранном уровне, стартовый комплект).
 *
 * Маршруты: `''` — список, `cls:<id>` — страница класса.
 */
import { STAT_LABEL } from '@dm/shared';
import type { ArtbookCtx } from './ctx.js';
import { SLOT_SETS, slotKey } from './model.js';
import { ATTR_ORDER, FACTION_LABEL, classNumbers, type ClassNumbers, type ClassPools } from './classNumbers.js';
import type { ClassLore } from './seed.js';
import { C, btn, chip, el, h2, h3, kv, muted, section, table } from './ui.js';

const LS_LEVEL = 'artbook_cls_level';
let level = (() => { try { return Math.max(1, Number(localStorage.getItem(LS_LEVEL)) || 20); } catch { return 20; } })();

interface ClassRow { id: string; name: string; enabled?: boolean }
const classesOf = (ctx: ArtbookCtx): ClassRow[] => (Array.isArray(ctx.data.classes) ? ctx.data.classes as ClassRow[] : []);

/** Классы в порядке брифа (сид), прочие — после, в порядке конфига. */
function ordered(ctx: ArtbookCtx): ClassRow[] {
  const order = ctx.view.classes.classes.map((c) => c.id);
  const rank = (id: string): number => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
  return [...classesOf(ctx)].sort((a, b) => rank(a.id) - rank(b.id));
}
const loreOf = (ctx: ArtbookCtx, id: string): ClassLore | undefined => ctx.view.classes.classes.find((c) => c.id === id);

export function renderCharacters(host: HTMLElement, ctx: ArtbookCtx): void {
  const id = ctx.route.startsWith('cls:') ? ctx.route.slice(4) : '';
  const cls = id ? classesOf(ctx).find((c) => c.id === id) : undefined;
  if (cls) renderClass(host, ctx, cls);
  else renderList(host, ctx);
}

function renderList(host: HTMLElement, ctx: ArtbookCtx): void {
  host.append(h2('Персонажи'));
  host.append(ctx.list('classes/intro', { paragraphs: true }));
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:10px');
  for (const c of ordered(ctx)) {
    const lore = loreOf(ctx, c.id);
    const card = el('div', `display:flex;gap:12px;padding:10px;border:1px solid ${C.edge};border-radius:8px;background:${C.bg};cursor:pointer`);
    card.addEventListener('click', () => ctx.go('cls:' + c.id));
    card.addEventListener('mouseenter', () => { card.style.borderColor = C.active; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = C.edge; });
    card.append(ctx.thumb(slotKey('cls', c.id, 'concept'), { w: 96, h: 120 }));
    const info = el('div', 'min-width:0;flex:1');
    info.append(el('div', `font-weight:700;font-size:14.5px;color:${C.text}`, c.name));
    const tags = el('div', 'display:flex;gap:4px;flex-wrap:wrap;margin:3px 0 6px');
    if (lore) tags.append(chip(lore.role, C.accent), chip(lore.attrs, C.dim));
    if (c.enabled === false) tags.append(chip('выключен в конфиге', C.faint));
    info.append(tags);
    if (lore) info.append(el('div', `font-size:12px;color:${C.soft};line-height:1.4`, lore.culture));
    else info.append(muted('описания в сиде нет'));
    card.append(info);
    grid.append(card);
  }
  if (!classesOf(ctx).length) grid.append(muted('В конфиге нет классов.'));
  host.append(grid);
}

const n1 = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ''));
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

function renderClass(host: HTMLElement, ctx: ArtbookCtx, cls: ClassRow): void {
  const top = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px');
  top.append(btn('← все классы', () => ctx.go('')), btn('открыть в конфиге →', () => ctx.gotoConfig('classes'), `color:${C.dim}`));
  host.append(top);
  const lore = loreOf(ctx, cls.id);
  const P = (f: string): string => `classes/classes/${cls.id}/${f}`;
  const title = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
  title.append(h2(cls.name));
  if (lore) title.append(chip(lore.role, C.accent), chip(lore.attrs, C.dim));
  if (cls.enabled === false) title.append(chip('выключен в конфиге', C.faint));
  host.append(title);

  const cols = el('div', 'display:grid;grid-template-columns:minmax(320px,1.1fr) minmax(320px,1fr);gap:14px;align-items:start');
  const left = el('div', 'min-width:0'), right = el('div', 'min-width:0');
  cols.append(left, right);
  host.append(cols);

  // Слева — концепты.
  left.append(ctx.slots(['cls', cls.id], SLOT_SETS.cls));

  // Справа — описание (правится на месте).
  if (lore) {
    right.append(h3('Культура-прототип'), ctx.text(P('culture')));
    right.append(h3('Кто это'), ctx.text(P('lore')));
    right.append(h3('Снаряжение'), ctx.text(P('gear')));
    right.append(h3('Стиль боя'), ctx.text(P('style')));
    right.append(h3('Сродство'), ctx.text(P('affinity')));
    right.append(h3('Заметки художнику'), ctx.text(P('artNotes'), { placeholder: 'пусто — нажми, чтобы записать заметку для художника' }));
  } else right.append(muted('Описания этого класса в сиде нет (seed/classes.json).'));

  // Живые числа.
  host.append(section('Живые числа из конфига (тем же кодом, что игра)', `cls:${cls.id}:numbers`, (body) => renderNumbers(body, ctx, cls.id), { open: true }));
}

function renderNumbers(body: HTMLElement, ctx: ArtbookCtx, id: string): void {
  let cn: ClassNumbers | null = null;
  try { cn = classNumbers(ctx.reg(), id, level); } catch (e) {
    body.append(el('div', `color:${C.bad};font-size:12.5px`, '⚠ Конфиг не разобрался — чисел нет: ' + (ctx.regError() ?? (e instanceof Error ? e.message : String(e)))));
    return;
  }
  if (!cn) { body.append(muted('Класса нет в конфиге.')); return; }

  const bar = el('div', 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:2px 0 8px');
  bar.append(el('span', `font-size:12px;color:${C.dim}`, 'Уровень для сравнения:'));
  const inp = el('input', `width:64px;padding:4px 6px;background:${C.input};color:${C.text};border:1px solid ${C.edge};border-radius:4px;font-size:13px`);
  inp.type = 'number'; inp.min = '1'; inp.max = '200'; inp.value = String(level);
  inp.addEventListener('change', () => {
    level = Math.max(1, Math.min(200, Math.floor(Number(inp.value)) || 1));
    try { localStorage.setItem(LS_LEVEL, String(level)); } catch { /* */ }
    ctx.rerender();
  });
  bar.append(inp);
  for (const l of [1, 10, 20, 40, 80]) bar.append(btn(String(l), () => { level = l; try { localStorage.setItem(LS_LEVEL, String(l)); } catch { /* */ } ctx.rerender(); }, `padding:2px 8px;${l === level ? `background:${C.active}` : ''}`));
  body.append(bar);
  body.append(muted('Новый герой из конфига (newCharacterSave), статы — снимок сессии (playerSnapshot) в стартовом комплекте. На выбранном уровне очки атрибутов НЕ вложены — их раскладывает игрок; сколько их будет — ниже.', 'margin-bottom:8px'));

  body.append(h3('Стартовые атрибуты'));
  body.append(table(ATTR_ORDER.map((a) => STAT_LABEL[a] ?? a), [ATTR_ORDER.map((a) => String(cn!.startAttributes[a]))]));
  if (cn.affinity.length) body.append(kv('Сродство (+урон)', cn.affinity.map((f) => FACTION_LABEL[f] ?? f).join(', ')));

  body.append(h3('Ресурсы и бой'));
  const pools = cn.pools;
  const rows: [string, (p: ClassPools) => string][] = [
    ['Здоровье', (p) => n1(p.hp)], ['Мана', (p) => n1(p.mana)], ['Выносливость', (p) => n1(p.stamina)],
    ['Реген здоровья, /с', (p) => n1(p.hpRegen)], ['Реген маны, /с', (p) => n1(p.manaRegen)], ['Реген выносливости, /с', (p) => n1(p.staminaRegen)],
    ['Урон (стартовое оружие)', (p) => `${n1(p.minDamage)}–${n1(p.maxDamage)}`], ['Скорость атаки', (p) => n1(p.attackSpeed)],
    ['Броня', (p) => n1(p.armor)], ['Меткость', (p) => n1(p.accuracy)], ['Уклонение', (p) => n1(p.evade)], ['Блок', (p) => pct(p.blockChance)],
    ['Скорость движения', (p) => n1(p.moveSpeed)],
  ];
  body.append(table(['', ...pools.map((p) => `ур. ${p.level}`)], rows.map(([k, f]) => [k, ...pools.map(f)]), { widths: ['220px'] }));
  if (cn.pointsAt.level > 1) {
    body.append(muted(`К ${cn.pointsAt.level}-му уровню у игрока: очков атрибутов ${cn.pointsAt.attribute}, очков скилов ${cn.pointsAt.skill}, очков мастерства ${cn.pointsAt.mastery}.`, 'margin:-4px 0 8px'));
  }

  body.append(h3('Стартовый комплект'));
  if (cn.startWeaponId && cn.weaponIssued && cn.weaponIssued !== cn.startWeaponId) {
    body.append(el('div', `font-size:12px;color:${C.warn};margin-bottom:4px`, `⚠ Оружие класса «${cn.startWeaponId}» выключено в конфиге — игра выдаёт родственное «${cn.weaponIssued}».`));
  } else if (cn.startWeaponId && !cn.weaponIssued) {
    body.append(el('div', `font-size:12px;color:${C.bad};margin-bottom:4px`, `⚠ Оружия «${cn.startWeaponId}» нет в игре — герой начинает без оружия.`));
  }
  body.append(table(['Предмет', 'Слот', 'Надет', 'Ступень', 'Урон', 'Скор. ат.', 'Броня', 'Требования', 'Прочее', 'Модель'],
    cn.kit.map((k) => [
      el('span', `color:${C.text}`, k.name), k.slotLabel, k.equipped ? 'да' : 'в сумке', k.tier || '—',
      k.damage ?? '—', k.attackSpeed !== undefined ? n1(k.attackSpeed) : '—', k.armor !== undefined ? n1(k.armor) : '—',
      k.req, k.stats || '—', k.modelId ? el('span', 'font-family:ui-monospace,monospace;font-size:11.5px', k.modelId) : el('span', `color:${C.faint}`, 'база слота'),
    ])));
}
