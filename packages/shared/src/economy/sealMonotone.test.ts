import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { RUN_MOD_DANGER_STATS, RUN_MOD_REWARD_STATS } from '../config/schemas.js';
import { liveSealDefs, sealBuffs, sealDangerOf, sealKey, sealTiers } from './seals.js';

/**
 * ⭐⭐ 23.10 (правка по АДВЕРСАРНОЙ РЕВИЗИИ): ЛЕСТНИЦА СТУПЕНЕЙ ИДЁТ ВПЕРЁД, А НЕ НАЗАД.
 *
 * ⚠⚠ ЧТО НАШЛА РЕВИЗИЯ. Доля награды считалась `min(sum, cap) × share`, где `share = зачтённая / сырая`
 * опасность. При упёртом потолке стата зачтённая СТОИТ НА МЕСТЕ, а сырая растёт множителем ступени — значит
 * доля падала ровно во столько раз, во сколько печать была сильнее. Замер нашёл 19 пар «ступень выше — награды
 * МЕНЬШЕ»: 4 × «Кишащий II» давали 0.600, а 4 × III — 0.450; три «Сторожевых I» (2 чемпиона, опыт ×2.30),
 * выменянные перековкой на одного «Сторожевого II», давали 1 чемпиона и опыт ×1.43. То есть ПЕРЕКОВКА —
 * единственный сток накопленных печатей — делала связку слабее, а ворота ступени по рекорду охраняли товар,
 * который хуже дешёвого.
 *
 * Правка: доля применяется ДО потолка награды (`min(sum × share, cap)`), а счётные события зачитываются по
 * ВЫДАННЫМ штукам. Этот файл — сторож на СВОЙСТВО, а не на числа: он перебирает все живые виды, все ступени и
 * 1…4 копии и требует монотонности. Числа пусть меняются в данных — порядок меняться не должен.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const TIERS = sealTiers(reg);
const KINDS = liveSealDefs(reg);
const COPIES = [1, 2, 3, 4];

/** Прибавка стата из свода связки (0 — «как обычно»). */
const add = (b: ReturnType<typeof sealBuffs>, stat: string): number => Math.max(0, (b as unknown as Record<string, number>)[stat]! - 1);

describe('⭐⭐ печати: лестница ступеней и число копий работают ВПЕРЁД', () => {
  it('⭐⭐ СТУПЕНЬ ВЫШЕ — не меньше опасности И не меньше награды (при любом числе копий)', () => {
    const rows: string[] = [];
    for (const def of KINDS) {
      for (const n of COPIES) {
        let prevD = -1;
        let prevR = -1;
        const line: string[] = [];
        for (const t of TIERS) {
          const b = sealBuffs(reg, { [sealKey(def.id, t.id)]: n });
          const d = add(b, def.danger.stat);
          const r = add(b, def.reward.stat);
          line.push(`${t.name}: ${d.toFixed(3)}/${r.toFixed(3)}`);
          expect(d + 1e-9, `${def.name} ×${n}: опасность упала на ступени ${t.name} (${prevD} → ${d})`).toBeGreaterThanOrEqual(prevD);
          expect(r + 1e-9, `${def.name} ×${n}: НАГРАДА упала на ступени ${t.name} (${prevR} → ${r}) — это и есть инверсия лестницы`).toBeGreaterThanOrEqual(prevR);
          prevD = d; prevR = r;
        }
        if (n === 4) rows.push(`${def.name} ×4 → ${line.join(' · ')}`);
      }
    }
    console.log('ЛЕСТНИЦА СТУПЕНЕЙ (опасность/награда при четырёх копиях)\n  ' + rows.join('\n  '));
  });

  it('⭐⭐ КОПИЙ БОЛЬШЕ — не меньше опасности и не меньше награды (стопка не наказывает)', () => {
    for (const def of KINDS) {
      for (const t of TIERS) {
        let prevD = -1;
        let prevR = -1;
        for (const n of COPIES) {
          const b = sealBuffs(reg, { [sealKey(def.id, t.id)]: n });
          const d = add(b, def.danger.stat);
          const r = add(b, def.reward.stat);
          expect(d + 1e-9, `${def.name} ${t.name}: опасность упала на ${n}-й копии`).toBeGreaterThanOrEqual(prevD);
          expect(r + 1e-9, `${def.name} ${t.name}: награда упала на ${n}-й копии`).toBeGreaterThanOrEqual(prevR);
          prevD = d; prevR = r;
        }
      }
    }
  });

  /**
   * ⚠⚠ И ОБРАТНАЯ СТОРОНА ТОГО ЖЕ ПРАВИЛА: награда не растёт БЕЗ опасности. Иначе «монотонность» лечилась бы
   * тем, что награда идёт целиком, — ровно дыра, из-за которой потолки стали парными 17.10.
   */
  it('⭐⭐ награда не растёт, когда опасность стоит (парные потолки целы)', () => {
    for (const def of KINDS) {
      for (const t of TIERS) {
        for (let n = 1; n < COPIES.length; n++) {
          const a = sealBuffs(reg, { [sealKey(def.id, t.id)]: COPIES[n - 1]! });
          const b = sealBuffs(reg, { [sealKey(def.id, t.id)]: COPIES[n]! });
          const dUp = add(b, def.danger.stat) - add(a, def.danger.stat);
          const rUp = add(b, def.reward.stat) - add(a, def.reward.stat);
          if (dUp <= 1e-9) {
            expect(rUp, `${def.name} ${t.name}: копия ${COPIES[n]} дала награду +${rUp.toFixed(3)} при той же опасности`).toBeLessThanOrEqual(1e-9);
          }
        }
      }
    }
  });

  it('⭐ связка из разных видов: опасность и топливо дропа растут вместе с ней', () => {
    const top = TIERS[TIERS.length - 1]!;
    let prev = -1;
    const line: string[] = [];
    const picks: Record<string, number> = {};
    for (const def of KINDS.slice(0, 4)) {
      picks[sealKey(def.id, top.id)] = 1;
      const danger = sealDangerOf(reg, picks);
      line.push(`${Object.keys(picks).length} вид(ов) → +${(danger * 100).toFixed(0)} %`);
      expect(danger + 1e-9, 'добавленный вид уменьшил суммарную опасность').toBeGreaterThanOrEqual(prev);
      prev = danger;
    }
    console.log('СВЯЗКА РАЗНЫХ ВИДОВ (старшая ступень): ' + line.join(' · '));
  });

  it('⭐ ни один наградный стат не выходит за свой потолок, ни один опасный — за свой', () => {
    const top = TIERS[TIERS.length - 1]!;
    const picks: Record<string, number> = {};
    for (const def of KINDS) picks[sealKey(def.id, top.id)] = 9;
    const b = sealBuffs(reg, picks);
    const caps = new Map(reg.get('run-mod-stats').map((s) => [s.id as string, s.cap]));
    for (const stat of [...RUN_MOD_DANGER_STATS, ...RUN_MOD_REWARD_STATS]) {
      expect(add(b, stat), `${stat} выше своего потолка`).toBeLessThanOrEqual((caps.get(stat) ?? Infinity) + 1e-9);
    }
  });
});
