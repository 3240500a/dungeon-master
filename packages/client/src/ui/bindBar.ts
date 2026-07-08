import type { SaveState, SkillNode } from '@dm/shared';
import type { App } from '../core/app.js';
import { elementColor, elementOf, abbrev } from '../modules/skills/skillIcon.js';

/** Бинд: id скилла, 'attack' (базовая атака) или null (пусто). */
type Binding = string | null;

interface SlotDef {
  label: string;
  big: boolean;
  get: (s: SaveState) => Binding;
  set: (s: SaveState, v: Binding) => void;
}

const SLOTS: SlotDef[] = [
  { label: 'ЛКМ', big: true, get: (s) => s.mouseLeft, set: (s, v) => { s.mouseLeft = v; } },
  { label: 'ПКМ', big: true, get: (s) => s.mouseRight, set: (s, v) => { s.mouseRight = v; } },
  { label: 'Shift', big: false, get: (s) => s.hotbar[0] ?? null, set: (s, v) => { s.hotbar[0] = v; } },
  { label: 'Space', big: false, get: (s) => s.hotbar[1] ?? null, set: (s, v) => { s.hotbar[1] = v; } },
  { label: 'Alt', big: false, get: (s) => s.hotbar[2] ?? null, set: (s, v) => { s.hotbar[2] = v; } },
];

/** Выученные активные скиллы (rank>0, есть активная способность). */
function learnedSkills(app: App): SkillNode[] {
  const save = app.state!.save;
  const tree = app.config.get('skills-active').find((t) => t.classId === save.classId);
  return (tree?.nodes ?? []).filter((n) => (save.activeSkills[n.id] ?? 0) > 0 && n.effect.active);
}

function nodeById(app: App, id: string): SkillNode | undefined {
  const save = app.state!.save;
  const tree = app.config.get('skills-active').find((t) => t.classId === save.classId);
  return tree?.nodes.find((n) => n.id === id);
}

/**
 * Панель биндов действий (D2): крупные ЛКМ/ПКМ + 3 доп. слота, клик → выпадающий
 * список (Атака / выученные скиллы / Пусто). Показывает кулдаун из app.skillCooldowns.
 * Переиспользуется в HUD и внизу окна скиллов.
 */
export function buildBindBar(app: App): { el: HTMLElement; refresh: () => void; rebuild: () => void } {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;align-items:flex-end;gap:6px;pointer-events:auto';

  const cdOverlays: { box: HTMLDivElement; binding: () => Binding }[] = [];

  const rebuild = (): void => {
    el.innerHTML = '';
    cdOverlays.length = 0;
    const save = app.state!.save;
    SLOTS.forEach((slot, i) => {
      if (i === 2) { // визуально отделяем 3 доп.слота от мыши
        const sep = document.createElement('div');
        sep.style.cssText = 'width:1px;height:44px;background:#2b323f;margin:0 4px;align-self:center';
        el.append(sep);
      }
      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px';
      const size = slot.big ? 52 : 40;
      const box = document.createElement('div');
      box.style.cssText =
        `position:relative;width:${size}px;height:${size}px;border-radius:8px;background:#0f131a;` +
        `border:1.5px solid #3e4756;display:flex;align-items:center;justify-content:center;` +
        `font-size:${slot.big ? 16 : 13}px;font-weight:700;cursor:pointer;overflow:hidden;user-select:none`;
      paintBox(app, box, slot.get(save));
      // Оверлей КД (заполняется снизу).
      const cd = document.createElement('div');
      cd.style.cssText = 'position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);height:0;pointer-events:none';
      box.append(cd);
      cdOverlays.push({ box: cd, binding: () => slot.get(app.state!.save) });
      box.addEventListener('click', (e) => { e.stopPropagation(); openDropdown(app, box, slot, rebuild); });
      col.append(box);
      col.append(mkLabel(slot.label));
      el.append(col);
    });
  };

  const refresh = (): void => {
    for (const o of cdOverlays) {
      const b = o.binding();
      const frac = b && b !== 'attack' ? (app.skillCooldowns[b] ?? 0) : 0;
      o.box.style.height = `${Math.round(frac * 100)}%`;
    }
  };

  rebuild();
  return { el, refresh, rebuild };
}

function mkLabel(text: string): HTMLElement {
  const l = document.createElement('div');
  l.style.cssText = 'font-size:10px;color:#8f897c';
  l.textContent = text;
  return l;
}

/** Рисует содержимое слота по биндингу (иконка скилла / «Атака» / пусто). Box пустой. */
function paintBox(app: App, box: HTMLDivElement, binding: Binding): void {
  let text: string;
  let color: string;
  let border: string;
  if (binding === null) { text = '—'; color = '#5a5750'; border = '#3e4756'; }
  else if (binding === 'attack') { text = '⚔'; color = '#e6ddc9'; border = '#c4bca8'; }
  else {
    const node = nodeById(app, binding);
    color = node ? elementColor(elementOf(node)) : '#3e4756';
    border = color;
    text = node ? abbrev(node.name) : '?';
  }
  box.style.borderColor = border;
  box.style.color = color;
  box.append(document.createTextNode(text));
}

let openMenu: HTMLElement | undefined;

/** Выпадающий список бинда над слотом: Атака / скиллы / Пусто. */
function openDropdown(app: App, anchor: HTMLElement, slot: SlotDef, onChange: () => void): void {
  openMenu?.remove();
  const menu = document.createElement('div');
  openMenu = menu;
  const r = anchor.getBoundingClientRect();
  menu.style.cssText =
    `position:fixed;left:${Math.round(r.left)}px;bottom:${Math.round(window.innerHeight - r.top + 6)}px;` +
    'min-width:170px;max-height:320px;overflow-y:auto;background:#171b24;border:0.5px solid #3e4756;' +
    'border-radius:8px;padding:4px;z-index:120;box-shadow:0 6px 20px rgba(0,0,0,0.5);pointer-events:auto';

  const set = (v: Binding): void => {
    slot.set(app.state!.save, v); // мгновенно для маппинга ввода
    app.sendCmd({ cmd: 'bind', slot: SLOTS.indexOf(slot), value: v }); // персист на сервере
    menu.remove();
    openMenu = undefined;
    onChange();
    app.bus.emit('state:changed', {});
  };

  const opt = (text: string, color: string, v: Binding): HTMLElement => {
    const o = document.createElement('div');
    o.style.cssText = `padding:6px 8px;border-radius:5px;cursor:pointer;font-size:13px;color:${color}`;
    o.textContent = text;
    o.addEventListener('mouseenter', () => (o.style.background = '#232a36'));
    o.addEventListener('mouseleave', () => (o.style.background = 'transparent'));
    o.addEventListener('click', (e) => { e.stopPropagation(); set(v); });
    return o;
  };

  menu.append(opt('⚔ Атака', '#e6ddc9', 'attack'));
  for (const n of learnedSkills(app)) {
    const rank = app.state!.save.activeSkills[n.id] ?? 1;
    menu.append(opt(`${abbrev(n.name)} · ${n.name} (ур.${rank})`, elementColor(elementOf(n)), n.id));
  }
  menu.append(opt('✕ Пусто', '#8f897c', null));

  document.body.append(menu);
  // Закрытие по клику вне.
  setTimeout(() => {
    const close = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) { menu.remove(); openMenu = undefined; document.removeEventListener('mousedown', close); }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}
