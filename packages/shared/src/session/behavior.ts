import type { ConfigShapes } from '../config/schemas.js';

/** Профиль поведения ИИ (одна запись `monster-behaviors` по фракции). */
export type MonsterBehavior = ConfigShapes['monster-behaviors'][number];
export type MonsterBehaviors = ConfigShapes['monster-behaviors'];

/** Безопасный дефолт (нежить-подобный) — если фракции нет в конфиге или конфиг пуст. */
export const DEFAULT_BEHAVIOR: MonsterBehavior = {
  faction: 'undead',
  alertDelaySec: 0, hearingMode: 'chase', leashTimeSec: 3.5, leashRadius: 560, returnHome: false,
  engageStyle: 'advance', fleeHpPct: 0, windupMult: 1, poise: 0, packCohesion: 0,
  keepDistMin: 140, keepDistMax: 220, repositionMode: 'strafe', repositionAfterShot: true, signature: 'none',
};

/** Профиль поведения по фракции монстра; фолбэк на дефолт, если фракции нет в списке. */
export function behaviorFor(faction: string, behaviors: MonsterBehaviors): MonsterBehavior {
  return behaviors.find((b) => b.faction === faction) ?? DEFAULT_BEHAVIOR;
}
