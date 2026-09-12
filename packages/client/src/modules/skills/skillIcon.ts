import { abilityElementOf, type SkillNode } from '@dm/shared';
import { dmgColor, dmgName } from '../../core/damageTypes.js';

/** Подписи клавиш слотов хотбара (слоты 0..3). */
export const HOTBAR_KEYS = ['ПКМ', 'Shift', 'Q', 'Alt'];

/** Псевдо-стихия «мастерство» — не тип урона, отдельный нейтральный цвет. */
const MASTERY_COLOR = '#6a6a7a';

/** Цвет стихии способности — из живых конфигов каналов урона (damage-kinds/magic-subtypes)
 * через dmgColor, кроме служебной «mastery». Без задвоения палитры. */
export function elementColor(el: string): string {
  return el === 'mastery' ? MASTERY_COLOR : dmgColor(el);
}
/** Имя стихии — из живого конфига каналов урона (через dmgName); «mastery» — служебная подпись. */
export function elementLabel(el: string): string {
  return el === 'mastery' ? 'Мастерство' : dmgName(el);
}

/**
 * Стихия способности (для цвета иконки). Явная `element` приоритетнее, иначе — по имени.
 * Мастерства — 'mastery'.
 *
 * ⚠ Угадывание по имени берём из `abilityElementOf` — ТОЙ ЖЕ функции, которой движок выбирает
 * стихию удара. Здесь стояла её копия, и копия уже разошлась: `nova` движок считает холодом,
 * а копия — физикой. То есть иконка и панель показывали одно, а бил скилл другим.
 */
export function elementOf(node: SkillNode): string {
  const active = node.effect.active;
  if (!active) return 'mastery';
  if ((active.category === 'attack' || active.category === 'cast' || active.category === 'curse') && active.element) return active.element;
  return abilityElementOf(active.abilityId);
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
