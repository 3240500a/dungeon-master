import type { RunModifier } from '../../config/schemas.js';
import { RUN_MOD_STAT_LIST } from './runModEffects.js';

/**
 * ⭐⭐ Ф5-0 (16.10): СТАТЫ ЭФФЕКТОВ `run-modifiers`, КОТОРЫЕ ИГРА ПРИМЕНЯЕТ. Раньше множество было ПУСТЫМ: алтарь
 * обещал «+10% здоровья», «золото +25%», «пачки +30%», а `effects` не читал никто — ни ядро, ни сервер, ни клиент,
 * id ехали только подписью этажа. Теперь живы десять статов, у которых есть шов (список и причина — в
 * `runModEffects.ts`): заселение этажа, вывод монстра и награда за убийство.
 *
 * ⚠ Подключаешь новый стат — вноси его в `RUN_MOD_STAT_LIST` ВМЕСТЕ со швом и тестом, что эффект действует.
 * Алтарь предлагает ровно те модификаторы, ВСЕ эффекты которых здесь (`runModifierLive`), поэтому стат без шва
 * молча вернёт окно к обещаниям без исполнения.
 */
export const RUN_MOD_LIVE_STATS: ReadonlySet<string> = new Set<string>(RUN_MOD_STAT_LIST);

type Mod = Pick<RunModifier, 'id' | 'enabled' | 'scope' | 'tags' | 'effects'>;

/** Действует ли модификатор: эффекты есть, и каждый игра применяет. */
export function runModifierLive(m: Mod, live: ReadonlySet<string> = RUN_MOD_LIVE_STATS): boolean {
  return m.effects.length > 0 && m.effects.every((e) => live.has(e.stat));
}

/**
 * Что алтарь предлагает под шаблон: забеговые (`scope:'run'`), включённые, разрешённые шаблоном (`allowedModifiers`; пусто —
 * все) и ДЕЙСТВУЮЩИЕ (`runModifierLive`). Пусто — секции модификаторов у алтаря нет.
 */
export function altarModifiers<M extends Mod>(mods: readonly M[], allowed: readonly string[] = [], live: ReadonlySet<string> = RUN_MOD_LIVE_STATS): M[] {
  return mods.filter((m) => m.enabled !== false && m.scope === 'run' && (allowed.length === 0 || allowed.includes(m.id)) && runModifierLive(m, live));
}

/** Благо (награда игроку) и опасность — по тегам данных. С обоими тегами — ни то, ни другое: цену несёт сам. */
const isBoon = (m: Mod): boolean => (m.tags.includes('boon') || m.tags.includes('reward')) && !m.tags.includes('danger');
const isDanger = (m: Mod): boolean => m.tags.includes('danger') && !m.tags.includes('boon') && !m.tags.includes('reward');

/**
 * ⭐ R8-12: ВЫБОР АЛТАРЯ → id модификаторов забега. Одно правило для сервера (`Room.buildRunConfig`) и плана
 * (`generateRunPlan` — и для забега, продолженного из сейва): только из `altarModifiers`, КАЖДЫЙ ОДИН РАЗ (было: 32 копии
 * «Реликвии алчности» доезжали до каждого этажа — эффект, сложенный умножением, дал бы ×1.15^32) и БЛАГО НЕ ДАРОМ: на
 * каждое благо — своя опасность; блага сверх числа опасностей отбрасываются по порядку выбора. Порядок — как выбрал игрок.
 */
export function pickRunModifiers(mods: readonly Mod[], allowed: readonly string[] | undefined, picked: unknown, live: ReadonlySet<string> = RUN_MOD_LIVE_STATS): string[] {
  const offer = new Map(altarModifiers(mods, allowed ?? [], live).map((m) => [m.id, m]));
  const ids = [...new Set(Array.isArray(picked) ? picked.filter((id): id is string => typeof id === 'string') : [])].filter((id) => offer.has(id));
  let dangers = ids.filter((id) => isDanger(offer.get(id)!)).length;
  return ids.filter((id) => !isBoon(offer.get(id)!) || dangers-- > 0);
}
