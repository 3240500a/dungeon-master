import * as THREE from 'three';
import {
  anatomyOf, partById, partFamily, resolveParts, resolveType, tagValue,
  type ConfigRegistry, type CraftParts,
} from '@dm/shared';
import { MatCache, SLOT_NAMES, type Builder, type MeshCtx, type PartView, type SlotName } from './core.js';
import { buildDagger, buildSword } from './blades.js';
import { buildAxe, buildMace } from './hafted.js';
import { buildHalberd, buildSpear } from './polearms.js';
import { buildBow, buildCrossbow } from './ranged.js';
import { buildStaff, buildWand } from './magic.js';

/**
 * ⭐ МОДЕЛЬ СКОВАННОГО ОРУЖИЯ ИЗ ЕГО ДЕТАЛЕЙ (docs/CRAFT_WEAPONS.md §18). Вход — тот же, что у
 * ковки (`CraftParts`): четыре варианта со ступенями. Выход — группа в сантиметрах, рукоять в
 * начале координат, рабочий конец в −Y (контракт — в `core.ts`).
 */

const BUILDERS: Record<string, Builder> = {
  sword: buildSword, dagger: buildDagger, axe: buildAxe, mace: buildMace,
  spear: buildSpear, halberd: buildHalberd, bow: buildBow, crossbow: buildCrossbow,
  wand: buildWand, staff: buildStaff,
};

/** Свечение стихии по базе магического оружия. */
const GLOW: Record<string, number> = { lightning: 0x9ec8ff, cold: 0x8fe8ff, poison: 0x7fe07a, fire: 0xff8a3a };

export interface CraftMeshResult {
  group: THREE.Group;
  /** Освободить геометрию и материалы, когда модель больше не нужна. */
  dispose(): void;
}

/** Контекст построителя из конфига и деталей. null — сборка не собирается (нет детали, не тот класс). */
export function meshCtx(reg: ConfigRegistry, weaponClass: string, hands: number, parts: CraftParts, mats: MatCache): MeshCtx | null {
  const anat = anatomyOf(reg, weaponClass);
  if (!anat) return null;
  const res = resolveParts(reg, weaponClass, hands, parts);
  // Окно материалов при превью не строжим: форму показываем и с материалом вне окна.
  const pick = (slot: SlotName) => (res.ok ? res.parts[slot] : partById(reg, parts[slot]?.id ?? ''));
  const views = {} as Record<SlotName, PartView>;
  for (const slot of SLOT_NAMES) {
    const p = pick(slot);
    if (!p) return null;
    const tags: Record<string, string> = {};
    for (const t of anat[slot].tags) tags[t.key] = tagValue(anat, slot, p, t.key);
    Object.assign(tags, p.tags);
    views[slot] = { id: p.id, name: p.name, axis: p.axis, step: parts[slot].step, family: partFamily(anat, slot, p), tags };
  }
  const type = res.ok ? resolveType(reg, weaponClass, hands, res.parts) : undefined;
  const base = reg.get('items.base').find((b) => b.id === type?.baseId);
  const dmgType = base && base.kind === 'weapon' ? base.damageType : '';
  const glow = weaponClass === 'wand' || weaponClass === 'staff'
    ? (base?.id.startsWith('archmage') ? 0xc08aff : GLOW[dmgType] ?? 0xc08aff)
    : 0;
  return {
    cls: weaponClass, hands, baseId: base?.id ?? '', parts: views, glow,
    tag: (slot, key) => views[slot].tags[key] ?? '',
    // Свечение стихии — у НАВЕРШИЯ магического оружия (ударное гнездо жезла и посоха), из какой бы семьи оно ни было: с 06.10 оно Прибор
    // (был снятый «Фокус»), и камень навершия светится по стихии базы поверх металла ступени.
    mat: (slot) => mats.of(views[slot].family, views[slot].step, slot === 'strike' ? glow : 0),
    matOf: (family, step) => mats.of(family, step, 0),
    fixed: (color, metalness, roughness) => mats.fixed(color, metalness, roughness),
  };
}

/** Собрать модель. null — нечего строить. */
export function buildCraftMesh(reg: ConfigRegistry, weaponClass: string, hands: number, parts: CraftParts): CraftMeshResult | null {
  const build = BUILDERS[weaponClass];
  const mats = new MatCache();
  let group: THREE.Group;
  try {
    const ctx = meshCtx(reg, weaponClass, hands, parts, mats);
    if (!build || !ctx) { mats.dispose(); return null; }
    group = build(ctx);
  } catch (e) {
    // Построитель упал посреди сборки: материалы уже заведены в кэше — отпускаем их здесь, иначе их
    // не освободит никто. Ошибку не глотаем: что показать, решает вызывающий (`craftWeapon3d` помечает
    // сборку несобираемой, вкладка ковки кузницы `forgeCraftTab` пишет «Модель сборки не строится»).
    mats.dispose();
    throw e;
  }
  return {
    group,
    dispose: () => {
      group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      mats.dispose();
    },
  };
}

export { MatCache } from './core.js';
