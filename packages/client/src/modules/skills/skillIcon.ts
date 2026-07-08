import type { SkillNode } from '@dm/shared';
import { dmgColor, dmgName } from '../../core/damageTypes.js';

/** Подписи клавиш слотов хотбара (слоты 0..3). */
export const HOTBAR_KEYS = ['ПКМ', 'Shift', 'Space', 'Alt'];

/** Псевдо-стихия «мастерство» — не тип урона, отдельный нейтральный цвет. */
const MASTERY_COLOR = '#6a6a7a';

/** Цвет стихии способности — из конфига `damage-types` (единый источник),
 * кроме служебной «mastery». Без задвоения с damage-types.json. */
export function elementColor(el: string): string {
  return el === 'mastery' ? MASTERY_COLOR : dmgColor(el);
}
/** Имя стихии — из конфига `damage-types`; «mastery» — служебная подпись. */
export function elementLabel(el: string): string {
  return el === 'mastery' ? 'Мастерство' : dmgName(el);
}

/** Стихия способности (для цвета иконки). Явная `element` приоритетнее, иначе — по имени. Мастерства — 'mastery'. */
export function elementOf(node: SkillNode): string {
  const active = node.effect.active;
  if (!active) return 'mastery';
  if (active.element) return active.element;
  const id = active.abilityId;
  if (/fire|flame|meteor/.test(id)) return 'fire';
  if (/frost|ice|cold|blizzard/.test(id)) return 'cold';
  if (/shock|lightning|storm/.test(id)) return 'lightning';
  if (/poison|venom/.test(id)) return 'poison';
  return 'physical';
}

export function abbrev(name: string): string {
  return name.replace(/^Мастерство:\s*/, '').slice(0, 2);
}

/** Иконка-заглушка скилла: цветной квадрат по стихии + 2 буквы. */
export function skillIcon(node: SkillNode, size = 30, draggable = false): HTMLElement {
  const color = elementColor(elementOf(node));
  const el = document.createElement('div');
  el.style.cssText =
    `width:${size}px;height:${size}px;flex:0 0 ${size}px;border-radius:6px;border:2px solid ${color};` +
    `color:${color};background:#0f131a;display:flex;align-items:center;justify-content:center;` +
    `font-size:12px;font-weight:600;${draggable ? 'cursor:grab' : ''}`;
  el.textContent = abbrev(node.name);
  if (draggable) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/skill', node.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
  }
  return el;
}
