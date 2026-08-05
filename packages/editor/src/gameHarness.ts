import { allocAttr, equip, unequip, allocActive, allocPassive, respec, respecSkills, respecPassives, moveInventoryItem, moveToBelt, debuffLabel, type SaveState, type TownCommand } from '@dm/shared';
import { App } from '@dm/client/core/app.js';
import { GameState } from '@dm/client/core/gameState.js';
import { setItemLabelResolvers } from '@dm/client/modules/inventory/itemView.js';
import { setDamageTypeMeta } from '@dm/client/core/damageTypes.js';
import { setRarityMeta } from '@dm/client/modules/loot/rarity.js';

/**
 * Мост «редактор → реальная игра»: строит настоящий `App` (@dm/client) + `GameState` из сейва, чтобы
 * калькулятор переиспользовал ПАНЕЛИ игры (стат-блок/паперкукла/атласы) — «одна истина» по статам.
 * Команды панелей (`allocAttr/equip/allocPassive/…`) применяются ТЕМИ ЖЕ функциями `townActions`, что
 * и сервер (одна истина по мутациям), сеть не трогаем. Золото раздуто → билд «свободный» (как d2planner).
 */
export function makeHarness(data: Record<string, unknown>, save: SaveState, onChange: () => void): App {
  const app = new App();
  app.config.loadAll(data);
  refreshResolvers(app);
  save.gold = 9_999_999; // калькулятор не гейтит по золоту (комиссии респеков/аллокаций покрыты)
  const gs = new GameState(save);
  app.state = gs; // сеттер подключает провайдеры дерайва/скиллов из конфига
  gs.hp = gs.derived().maxHp; gs.mana = gs.derived().maxMana; gs.stamina = gs.derived().maxStamina;
  app.sendCmd = (cmd: TownCommand): void => { applyCmd(app, gs, cmd); onChange(); };
  return app;
}

function applyCmd(app: App, gs: GameState, cmd: TownCommand): void {
  const reg = app.config, s = gs.save;
  switch (cmd.cmd) {
    case 'allocAttr': allocAttr(s, cmd.attr); break;
    case 'equip': equip(reg, s, cmd.uid); break;
    case 'unequip': unequip(reg, s, cmd.slot); break;
    case 'allocSkill': allocActive(reg, s, cmd.nodeId); break;
    case 'allocPassive': allocPassive(reg, s, cmd.nodeId); break;
    case 'respec': respec(reg, s); break;
    case 'respecSkills': respecSkills(reg, s); break;
    case 'respecPassives': respecPassives(reg, s); break;
    case 'moveItem': moveInventoryItem(reg, s, cmd.uid, cmd.x, cmd.y); break;
    case 'moveBelt': moveToBelt(s, cmd.uid); break;
    case 'drop': { const i = s.inventory.findIndex((it) => it.uid === cmd.uid); if (i >= 0) s.inventory.splice(i, 1); break; } // «выбросить» = просто убрать из билда
    default: break; // прочие команды (магазин/квесты) калькулятору не нужны
  }
}

function refreshResolvers(app: App): void {
  setItemLabelResolvers({
    armorClass: (id) => app.config.get('armor-classes').find((c) => c.id === id)?.name ?? id,
    weight: (id) => (app.config.get('weapon-weights').find((w) => w.id === id)?.name ?? id).toLowerCase(),
    physSub: (id) => { const sub = app.config.get('phys-subtypes').find((x) => x.id === id); return sub ? `${sub.name.toLowerCase()} → ${debuffLabel(app.config.get('debuffs'), sub.kind).toLowerCase()}` : id; },
    skill: (id) => app.config.get('skill-tree').nodes.find((n) => n.id === id)?.name ?? id,
  });
  const phys = app.config.get('damage-kinds').find((k) => k.id === 'physical');
  setDamageTypeMeta({
    ...(phys ? { physical: { name: phys.name, short: phys.short, color: phys.color, ailment: null } } : {}),
    ...Object.fromEntries(app.config.get('magic-subtypes').map((s) => [s.id, { name: s.name, short: s.short, color: s.color, ailment: s.ailment }])),
  });
  setRarityMeta(Object.fromEntries(app.config.get('rarities').map((r) => [r.id, { name: r.name, color: r.color }])));
}
