import type { App } from '../../core/app.js';
import { socketsOpen, insertById, insertRank, insertUnlocked, insertFits, resolveActive, type SkillTreeNode } from '@dm/shared';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { elementColor, elementOf } from './skillIcon.js';

/** Пул ресурса словом. Короткое: строка итога и так длинная, а «выносливости» в неё не влезает. */
const POOL_SHORT: Record<'mana' | 'stamina', string> = { mana: 'маны', stamina: 'выносл.' };

/**
 * Ценник вставки словом. Он ПЛОСКИЙ и одинаковый в любом скиле — ради этого и заведён: доля от
 * цены носителя означала «3 маны тут и 10 там», и сравнить сборки было нечем.
 */
const priceText = (ins: { cost: number; costPool: 'carrier' | 'mana' | 'stamina' }, carrier?: 'mana' | 'stamina'): string => {
  if (!ins.cost) return 'бесплатно';
  const pool = ins.costPool === 'carrier' ? carrier : ins.costPool;
  return `${ins.cost > 0 ? '+' : ''}${ins.cost} ${pool ? POOL_SHORT[pool] : 'ресурса скила'}`;
};

/**
 * СБОРКА СКИЛА: гнёзда выученных активок и вставки в них.
 *
 * Панель НИЧЕГО НЕ РЕШАЕТ САМА — клик шлёт `socketInsert`/`socketClear`, а сервер отвечает
 * «да/нет». Здесь мы лишь НЕ ПОКАЗЫВАЕМ заведомо невозможное (закрытую вставку, чужое оружие,
 * занятый тип), чтобы игрок не тыкал в отказы; отказ всё равно возможен — и это правильно.
 *
 * Итоговые числа берутся из `resolveActive` — того же шва, которым считает сервер и редактор.
 */

/** Какой узел раскрыт в списке (переживает перерисовку панели). */
let openNode = '';

const CARD = `background:${COLORS.panel2};border:1px solid ${COLORS.border};border-radius:8px`;

export function renderSockets(app: App, body: HTMLElement): void {
  const cfg = app.config;
  const save = app.state!.save;
  const tree = cfg.get('skill-tree');

  // Собирать можно только выученные активки — гнёзда открываются рангом.
  const learned = (tree.nodes as SkillTreeNode[])
    .filter((n) => n.effect.active && socketsOpen(cfg, save.skills[n.id] ?? 0) > 0);

  body.append(mk('h4', 'margin:12px 0 6px', 'Сборка скилов'));
  if (!learned.length) {
    const ranks = cfg.get('balance').skillSocketRanks;
    body.append(mk('div', `font-size:11px;color:${COLORS.dim}`,
      `Гнёзда открываются рангом скила: ${ranks.join(' / ')}. Вложите очко в активный скил.`));
    return;
  }
  if (!learned.some((n) => n.id === openNode)) openNode = learned[0]!.id;

  // Ряд выученных активок — переключатель.
  const row = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px');
  for (const n of learned) {
    const on = n.id === openNode;
    const b = mk('button',
      `padding:4px 10px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid ${on ? COLORS.gold : COLORS.border};` +
      `background:${on ? COLORS.panel : COLORS.panel2};color:${on ? COLORS.text : COLORS.dim}`) as HTMLButtonElement;
    const filled = (save.sockets?.[n.id] ?? []).filter(Boolean).length;
    const open = socketsOpen(cfg, save.skills[n.id] ?? 0);
    b.textContent = `${n.name} ${filled}/${open}`;
    b.addEventListener('click', () => { openNode = n.id; app.bus.emit('state:changed', {}); });
    row.append(b);
  }
  body.append(row);

  const node = learned.find((n) => n.id === openNode)!;
  const base = node.effect.active!;
  const open = socketsOpen(cfg, save.skills[node.id] ?? 0);
  const slots = save.sockets?.[node.id] ?? [];
  const typeName = (id: string): string => cfg.get('skill-insert-types').find((t) => t.id === id)?.name ?? id;

  const grid = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px');
  for (let i = 0; i < open; i++) {
    const cur = slots[i] ?? null;
    const ins = cur ? insertById(cfg, cur) : undefined;
    const cell = mk('div', `${CARD};min-width:150px;padding:6px 8px;cursor:pointer;` +
      `border-color:${ins ? elementColor(elementOf(node)) : COLORS.border}`);
    // Ранг вставки — это ранг её узла в дереве: качается там же, где всё остальное.
    const rk = ins ? insertRank(cfg, save, ins.id) : 0;
    cell.append(mk('div', `font-size:10px;color:${COLORS.dim}`, ins ? typeName(ins.type) : `Гнездо ${i + 1}`));
    cell.append(mk('div', `font-size:12px;color:${ins ? COLORS.text : COLORS.dim}`,
      ins ? `${ins.name} · ${rk}` : '— пусто —'));
    if (ins) {
      attachTooltip(cell, () => `<div style="color:${COLORS.text};font-weight:bold">${ins.name}</div>` +
        `<div style="color:#9aa">${typeName(ins.type)} · ранг ${rk}</div>` +
        `<div style="color:#c4bca8">${ins.description}</div>` +
        `<div style="color:#9aa;margin-top:3px">цена ${priceText(ins, base.resource)} · откат ×${ins.cooldownMult}</div>` +
        `<div style="color:${COLORS.dim};margin-top:3px">ранг растёт от очков в узле-доноре · клик — заменить или вынуть</div>`);
    }
    cell.addEventListener('click', () => openPicker(app, cell, node, i, cur));
    grid.append(cell);
  }
  body.append(grid);

  // Итог сборки — те же числа, что посчитает сервер.
  const r = resolveActive(cfg, save, node.id);
  if (r) {
    const b = base as { manaCost: number; cooldown: number };
    const a = r.active as { manaCost: number; cooldown: number; resource: 'mana' | 'stamina' };
    const d = (was: number, now: number): string => was === now
      ? String(now)
      : `<span style="color:${now > was ? COLORS.bad : COLORS.good}">${was} → ${now}</span>`;
    const line = mk('div', `font-size:11px;color:${COLORS.dim}`);
    // ⭐ ЦЕНЫ ДВЕ. Магическая вставка не удорожает пул носителя, а берёт свой — и если её не показать,
    // игрок увидит «цена не изменилась» и решит, что вставка бесплатна.
    line.innerHTML = `Стоимость: ${d(b.manaCost, a.manaCost)} ${POOL_SHORT[a.resource]}`
      + (r.extraCost ? ` <span style="color:${COLORS.bad}">+ ${r.extraCost.amount} ${POOL_SHORT[r.extraCost.pool]}</span>` : '')
      + ` · откат: ${d(b.cooldown, a.cooldown)} с`
      + (r.procs.length ? ` · доп. эффектов: ${r.procs.length}` : '');
    body.append(line);
  }
  body.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:4px`,
    'Вставки открываются узлами дерева и УСИЛИВАЮТСЯ его рангом. Вынуть можно бесплатно.'));
}

/** Выпадающий выбор вставки для гнезда. Показываем ТОЛЬКО то, что реально можно поставить. */
function openPicker(app: App, anchor: HTMLElement, node: SkillTreeNode, slot: number, cur: string | null): void {
  document.querySelectorAll('[data-socket-picker]').forEach((e) => e.remove());
  const cfg = app.config;
  const save = app.state!.save;
  const base = node.effect.active!;
  const weaponClass = save.equipment.weapon?.weaponClass;
  const open = socketsOpen(cfg, save.skills[node.id] ?? 0);
  const others = (save.sockets?.[node.id] ?? []).slice(0, open).filter((_, i) => i !== slot);
  const usedTypes = new Set(others.map((id) => (id ? insertById(cfg, id)?.type : undefined)).filter(Boolean) as string[]);

  const menu = mk('div', `${CARD};position:absolute;z-index:60;min-width:230px;max-height:300px;overflow-y:auto;` +
    `padding:4px;box-shadow:0 8px 24px #000a`);
  menu.setAttribute('data-socket-picker', '1');
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.position = 'fixed';

  const item = (label: string, color: string, on: () => void, tip?: () => string): void => {
    const el = mk('div', `padding:5px 8px;font-size:12px;border-radius:4px;cursor:pointer;color:${color}`);
    el.textContent = label;
    el.addEventListener('mouseenter', () => { el.style.background = COLORS.panel; });
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
    el.addEventListener('click', () => { menu.remove(); on(); });
    if (tip) attachTooltip(el, tip);
    menu.append(el);
  };

  if (cur) item('✕ Вынуть', COLORS.bad, () => app.sendCmd({ cmd: 'socketClear', nodeId: node.id, slot }));

  const typeName = (id: string): string => cfg.get('skill-insert-types').find((t) => t.id === id)?.name ?? id;
  let any = false;
  for (const ins of cfg.get('skill-inserts')) {
    if (ins.enabled === false || ins.id === cur) continue;
    if (!insertUnlocked(cfg, save, ins.id)) continue;              // не открыта деревом
    if (!insertFits(ins, base, weaponClass)) continue;             // не та категория/оружие
    if (usedTypes.has(ins.type)) continue;                         // тип занят другим гнездом
    any = true;
    item(`${typeName(ins.type)} · ${ins.name}`, COLORS.text,
      () => app.sendCmd({ cmd: 'socketInsert', nodeId: node.id, slot, insertId: ins.id }),
      () => `<div style="color:${COLORS.text};font-weight:bold">${ins.name}</div>` +
        `<div style="color:#c4bca8">${ins.description}</div>` +
        `<div style="color:#9aa;margin-top:3px">цена ${priceText(ins, base.resource)} · откат ×${ins.cooldownMult}</div>`);
  }
  if (!any && !cur) {
    menu.append(mk('div', `padding:6px 8px;font-size:11px;color:${COLORS.dim}`,
      'Подходящих открытых вставок нет — откройте их узлами дерева.'));
  }

  document.body.appendChild(menu);
  const close = (e: MouseEvent): void => {
    if (menu.contains(e.target as Node)) return;
    menu.remove();
    window.removeEventListener('mousedown', close, true);
  };
  setTimeout(() => window.addEventListener('mousedown', close, true), 0);
}
