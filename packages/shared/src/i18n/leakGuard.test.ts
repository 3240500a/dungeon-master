import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { cyrillicLeaks, pseudoLocales } from './pseudo.js';
import { withTextLang } from './tr.js';
import { unityViewsSample } from '../views/unityViews.testkit.js';
import { generateMonster } from '../formulas/monstergen.js';
import { createRng } from '../formulas/rng.js';
import { monsterDefView } from '../session/serialize.js';
import { localizeFrame, monsterDisplayName } from '../session/frameText.js';
import type { ServerFrame } from '../session/netTypes.js';
import type { SessionEvent } from '../session/session.js';
import type { ScaledMonster } from '../types/world.js';

/**
 * ⭐⭐ i18n Ф2 (06.11): СТОРОЖ УТЕЧЕК (shared) — модели окон и кадры с запечёнными именами на ПСЕВДОЯЗЫКЕ (`pseudoLocales`: каждый ключ `cfg:`
 * и `srv:` переведён транслитом, кириллицы в переводе нет). Рендерятся ТЕ ЖЕ виды на ТОМ ЖЕ богатом сейве, что у эталона Unity
 * (`unityViews.testkit.ts`: лист, древо, мастерство, сбросы, задания, гнёзда, бинды, меню и подсказки вещей, примерка, сырьё, верстак, лавка,
 * обмен, портал, отрезок, перековка, карта, окно смерти, вопрос голосования, ковка), и кадры, где имена лежат готовыми (сейв, сундук,
 * прилавок, доска заданий, события, монстры каждой заготовки и редкости). Кириллица в выводе — утечка: текст мимо шва.
 * Полный провод настоящей комнатой — `server/src/net/room.leak.test.ts`.
 *
 * ⚠ РАЗРЕШЕНО ЯВНО (`ALLOW`): имя героя образца (набрано игроком) и имя «последней цели» листа — литерал образца эталона; живая комната
 * кладёт туда имя монстра на языке игрока (`Room.lastTargetShown` → `monsterDisplayName`, проверено сторожем комнаты).
 */
const ALLOW = ['Образец', 'Зомби'];

const cfg = new ConfigRegistry();
cfg.loadAll();
const xx = pseudoLocales(cfg.get('locales'), defaultConfigData);
const inXx = <T>(fn: () => T): T => withTextLang(xx, 'xx', fn);

describe('⭐⭐ i18n Ф2: сторож утечек — виды и кадры на псевдоязыке без кириллицы', () => {
  it('⭐⭐ ВСЕ модели окон эталона Unity — на псевдоязыке ни одной кириллической буквы', () => {
    const s = inXx(() => unityViewsSample(cfg));
    const leaks: string[] = [];
    for (const [group, part] of Object.entries(s.out)) {
      if (typeof part !== 'object' || !part) continue;
      for (const [k, v] of Object.entries(part)) for (const l of cyrillicLeaks(JSON.stringify(v), ALLOW)) leaks.push(`${group}.${k}: …${l}…`);
    }
    expect(leaks.slice(0, 20)).toEqual([]);
    // ⚠ контроль: те же виды на языке-источнике — русские (сторож кириллицу видит), и побайтово равны эталону без области
    const ru = unityViewsSample(cfg).out;
    expect(cyrillicLeaks(JSON.stringify(ru), ALLOW).length).toBeGreaterThan(100);
  });

  it('⭐⭐ кадры с запечёнными именами — сейв, сундук, прилавок, доска, события: на псевдоязыке без кириллицы, на источнике — тот же объект', () => {
    const s = unityViewsSample(cfg);
    const mon = generateMonster(cfg.get('monsters'), cfg.get('monster-gear'), cfg.get('monster-affixes'), {
      depth: 9, itemAffixes: cfg.get('monster-item-affixes'), rarities: cfg.get('rarities'), rarity: 'rare',
      monsterRarity: cfg.get('monster-rarity'), monsterUniques: cfg.get('monster-uniques'), gearTiers: cfg.get('monster-gear-tiers'),
    }, createRng(4));
    const events: SessionEvent[] = [
      ...s.bag.map((item): SessionEvent => ({ type: 'item-dropped', item, x: 0, y: 0, from: 'chest' })),
      { type: 'item-picked', playerId: 'p', item: s.bag[2]!, x: 0, y: 0 },
      { type: 'monster-died', id: 1, def: monsterDefView(mon) as unknown as ScaledMonster, x: 0, y: 0 },
      ...s.save.activeQuestDefs.map((d): SessionEvent => ({ type: 'quest', playerId: 'p', kind: 'accepted', questId: d.id, name: d.name })),
    ];
    const questOf = (id: string) => s.save.activeQuestDefs.find((d) => d.id === id) ?? s.board.find((d) => d.id === id);
    const frames: ServerFrame[] = [
      { t: 'saveUpdate', save: s.save },
      { t: 'stash', tabs: [s.bag, s.stock], cols: 10, rows: 10, tabCount: 2, materials: {}, forgeJournal: { bases: [], variants: [], sketches: 0 } as never },
      { t: 'shop', items: s.stock, prices: {} },
      { t: 'questBoard', quests: s.board },
      { t: 'events', events },
      { t: 'monsterInfo', monsters: [{ id: 1, def: monsterDefView(mon), x: 0, y: 0 }] },
    ];
    for (const f of frames) {
      const shown = inXx(() => localizeFrame(cfg, f, questOf));
      expect(cyrillicLeaks(JSON.stringify(shown), ALLOW).slice(0, 5), `кадр ${f.t}`).toEqual([]);
      expect(localizeFrame(cfg, f, questOf), `кадр ${f.t}: источник — тот же объект`).toBe(f);
    }
  });

  it('⭐⭐ ИМЯ МОНСТРА: каждая заготовка × каждая редкость пересобирается сверкой — на псевдоязыке без кириллицы, на источнике как испечено', () => {
    const leaks: string[] = [];
    let n = 0;
    for (const tpl of cfg.get('monsters')) {
      for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
        for (let seed = 1; seed <= 3; seed++) {
          const m = generateMonster(cfg.get('monsters'), cfg.get('monster-gear'), cfg.get('monster-affixes'), {
            baseId: tpl.id, depth: 4 + seed * 7, itemAffixes: cfg.get('monster-item-affixes'), rarities: cfg.get('rarities'), rarity,
            monsterRarity: cfg.get('monster-rarity'), monsterUniques: cfg.get('monster-uniques'), gearTiers: cfg.get('monster-gear-tiers'),
          }, createRng(seed * 31 + n));
          n++;
          expect(monsterDisplayName(cfg, m), 'источник — испечённое').toBe(m.name);
          const shown = inXx(() => monsterDisplayName(cfg, m));
          if (/[Ѐ-ӿ]/.test(shown)) leaks.push(`${tpl.id}/${rarity}: «${m.name}» → «${shown}»`);
          const def = inXx(() => localizeFrame(cfg, { t: 'monsterInfo', monsters: [{ id: 1, def: monsterDefView(m), x: 0, y: 0 }] }));
          if (/[Ѐ-ӿ]/.test(JSON.stringify(def))) leaks.push(`${tpl.id}/${rarity}: снаряжение ${JSON.stringify(monsterDefView(m).gearRolls)}`);
        }
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(leaks.slice(0, 10)).toEqual([]);
  });
});
