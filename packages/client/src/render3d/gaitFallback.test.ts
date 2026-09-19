import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { localStorageContent } from './poseRuntime.js';
import { BASE_GAIT_CHAR, locoClipNames } from './locoBlend.js';
import type { Clip } from './clipModel.js';

/**
 * ⭐⭐ ДОНОР НАБОРА ХОДА — И У ИГРОКОВ ТОЖЕ.
 *
 * ЗАМЕР 19.09, опровергший посылку плана «игра уже ходит только клипами»: режим клипов включается
 * условием `clipOnly = доля>=0.999 && hasLocoSet()`. Игра ставит долю в 1 безусловно, но `hasLocoSet`
 * ищет `run_fwd`/`walk_fwd` по цепочке персонажей — а игроки собирались ВООБЩЕ БЕЗ донора: донора
 * получали только монстры. Значит каждый класс без своего запечённого набора уезжал в игре на
 * процедурный планировщик, и это не редкий угол: свой набор запечён у воина, а классов семь.
 *
 * ⚠ ПОЧЕМУ ДОНОР ХОДА ОТДЕЛЬНЫЙ, А НЕ ОБЫЧНЫЙ `fallbackId`. Обычный подменяет ВЕСЬ контент персонажа:
 * стойки, боевые стойки, удары, клипы состояний и — через `readAnimCfg` — конфиг предметов ЦЕЛИКОМ
 * (а не по недостающим ключам). Раздать такой донор классам значило бы молча отдать магу воинские
 * стойки и воинскую классификацию предметов. Донор ХОДА одалживает ровно клип локомоции.
 */
const CH = 'mage', DONOR = BASE_GAIT_CHAR;
const clip = (name: string, character: string): Clip =>
  ({ name, character, weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }, { t: 0.5, pose: {} }] }) as unknown as Clip;

const store: Record<string, string> = {};
const withClips = <T,>(clips: Clip[], fn: () => T): T => {
  store['pe_clips'] = JSON.stringify(clips);
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; }, clear: () => { /* */ }, key: () => null, length: 0,
  } as unknown as Storage;
  return fn();
};
afterEach(() => { for (const k of Object.keys(store)) delete store[k]; });

const RUN_FWD = locoClipNames('fwd', true);

describe('донор набора хода', () => {
  it('⭐⭐ КЛАСС БЕЗ СВОЕГО НАБОРА БЕРЁТ ПОХОДКУ У ДОНОРА (иначе уедет на планировщик)', () => {
    withClips([clip(RUN_FWD[0]!, DONOR)], () => {
      const c = localStorageContent(CH, undefined, DONOR);
      expect(c.locoClip?.(RUN_FWD, 'none')?.character,
        '⚠ походки нет → `hasLocoSet` ложен → кукла уезжает на процедурный планировщик прямо в игре').toBe(DONOR);
    });
  });

  it('⭐⭐ НО СТОЙКИ, УДАРЫ И БОЕВУЮ СТОЙКУ КЛАСС У ДОНОРА НЕ БЕРЁТ', () => {
    // Ровно та граница, ради которой заведён отдельный аргумент: одалживаем походку, не личность.
    withClips([clip(RUN_FWD[0]!, DONOR), clip('idle_sword', DONOR), clip('hit_sword', DONOR)], () => {
      const c = localStorageContent(CH, undefined, DONOR);
      expect(c.locoClip?.(RUN_FWD, 'none')?.character, 'походка — донорская').toBe(DONOR);
      expect(c.resolveUpper('sword'), '⚠ стойка донора протекла к классу').toBeNull();
      expect(c.attackClip?.('sword'), '⚠ удар донора протёк к классу').toBeNull();
    });
  });

  it('⭐ СВОЙ НАБОР ВСЕГДА БЬЁТ ДОНОРСКИЙ', () => {
    withClips([clip(RUN_FWD[0]!, DONOR), clip(RUN_FWD[0]!, CH)], () => {
      expect(localStorageContent(CH, undefined, DONOR).locoClip?.(RUN_FWD, 'none')?.character).toBe(CH);
    });
  });

  it('⭐ ПОРЯДОК ТРЁХ СТУПЕНЕЙ: свой → общий донор контента → донор походки', () => {
    withClips([clip(RUN_FWD[0]!, DONOR), clip(RUN_FWD[0]!, 'mon_undead')], () => {
      // У монстра есть общий донор `mon_undead`; он обязан выиграть у донора походки.
      expect(localStorageContent(CH, 'mon_undead', DONOR).locoClip?.(RUN_FWD, 'none')?.character).toBe('mon_undead');
    });
  });

  it('донор, совпадающий с самим персонажем, не создаёт лишнего прохода и не ломает ответ', () => {
    withClips([clip(RUN_FWD[0]!, CH)], () => {
      expect(localStorageContent(CH, undefined, CH).locoClip?.(RUN_FWD, 'none')?.character).toBe(CH);
    });
    withClips([], () => {
      expect(localStorageContent(CH, undefined, DONOR).locoClip?.(RUN_FWD, 'none'), 'нет ни у кого — честный null').toBeNull();
    });
  });

  it('⚠⚠ ИГРОКИ СОБИРАЮТСЯ С ДОНОРОМ ПОХОДКИ (это и была дыра)', () => {
    const src = readFileSync(path.join(__dirname, 'gamePlayerDoll.ts'), 'utf8');
    const i = src.indexOf('const content = opts.classId');
    expect(i, '⚠ сборка контента куклы не найдена').toBeGreaterThan(0);
    const line = src.slice(i, i + 260);
    expect(line.includes('BASE_GAIT_CHAR'),
      '⚠ игрок снова собирается без донора походки: класс без своего run_fwd уедет на планировщик').toBe(true);
    expect(/localStorageContent\(opts\.classId,\s*undefined,/.test(line),
      '⚠ игроку выдали ОБЩИЙ донор контента вместо донора походки — он утащит чужие стойки и удары').toBe(true);
  });

  it('имя донора — ОДНО на игроков и монстров, литералов не осталось', () => {
    const on3d = readFileSync(path.join(__dirname, 'online3d.ts'), 'utf8');
    expect(on3d.includes("gaitFallback: BASE_GAIT_CHAR"), 'монстры берут ту же константу').toBe(true);
    expect(on3d.includes("gaitFallback: 'warrior'"), '⚠ литерал донора вернулся — второе место правды').toBe(false);
  });
});
