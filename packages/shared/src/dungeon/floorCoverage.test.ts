/**
 * ⭐⭐ Г8-5 (15.10, просьба владельца): ПОКРЫТИЕ КОНТЕНТА — «давай нормально доделаем всё это, заведём шаблоны
 * этажей, каких нет ещё, чтобы всё чётко было».
 *
 * ⚠⚠ ЗАЧЕМ ЭТОТ ФАЙЛ. Дыры в контенте не падают и не кричат — они МОЛЧА подменяются фолбэком. Подбор этажа роли
 * никогда не отвечает «нет»: промахнулось окно глубины — берётся ближайшее, нет этажа роли вовсе — берётся любой
 * этаж биома. Поэтому настройка может обещать одно, а игра показывать другое, и единственный способ это заметить —
 * сверять МАТРИЦУ «биом × роль × место круга» числом. Замер 15.10 (до правки): у крипты боевые этажи кончались на
 * 15-м месте круга — места 16–20, включая подход к актовому боссу на 19-м, шли катакомбами по фолбэку; ролей
 * `event` и `shop` не было ни одного этажа ни у одного биома, при этом шаблон давал им вес 1.
 *
 * Что файл обязан валить:
 *  • роль с НЕНУЛЕВЫМ весом, у которой нет этажа у включённого биома (обещание без контента);
 *  • место круга, не покрытое своим боевым этажом (узел возьмёт чужой фолбэком);
 *  • место лестницы боссов вне окна боссового этажа (то же молчание, но про босса);
 *  • роль рядового узла, выбранную ВНЕ её окна глубины (окна снова стали декоративными).
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { generateRunPlan, defaultRunConfig } from './run/generateRunPlan.js';
import { availableRolesAt, pickFloorForRole } from './floorSpec.js';
import { bandDepth } from '../formulas/power.js';
import type { Floor, FloorRole } from '../config/schemas.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
const cfg = reg();
const access = cfg.get('balance').dungeonAccess;
const CYCLE = access.contentCycle;
const floors = cfg.get('floors') as Floor[];
const biomesOn = cfg.get('biomes').filter((b) => b.enabled !== false);
const tpl = { nodeTypeWeights: cfg.get('balance').dungeonAccess.nodeTypeWeights };   // ⚠ Ф1: веса живут в балансе
const places = Array.from({ length: CYCLE }, (_, i) => i + 1);
const on = (f: Floor): boolean => f.enabled !== false;

describe('⭐⭐ Г8-5: покрытие контента — матрица «биом × роль × место круга»', () => {
  it('⭐⭐ РОЛЬ С ВЕСОМ ОБЯЗАНА ИМЕТЬ ЭТАЖ: вес без контента — обещание, которое молча подменит фолбэк', () => {
    const weights = tpl.nodeTypeWeights as Record<string, number>;
    const wanted = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0).map(([r]) => r as FloorRole);
    const miss: string[] = [];
    for (const b of biomesOn) {
      for (const role of wanted) {
        if (!floors.some((f) => on(f) && f.biomeId === b.id && f.role === role)) miss.push(`${b.id}/${role}`);
      }
    }
    expect(miss, 'роли с весом, у которых нет ни одного этажа').toEqual([]);
    // ⚠ И ОБРАТНОЕ: роль БЕЗ этажей обязана иметь вес 0, иначе генератор её пообещает.
    const roles: FloorRole[] = ['combat', 'elite', 'treasure'];   // ⚠ Ф1: event/shop сняты из схемы вовсе
    for (const role of roles) {
      const has = biomesOn.every((b) => floors.some((f) => on(f) && f.biomeId === b.id && f.role === role));
      if (!has) expect(weights[role] ?? 0, `роль «${role}» без этажей обязана иметь вес 0`).toBe(0);
    }
    // eslint-disable-next-line no-console
    console.log('Г8-5 ВЕСА ТИПОВ: ' + Object.entries(weights).map(([k, v]) => `${k} ${v}`).join(' · ')
      + '; роли с контентом: ' + roles.filter((r) => biomesOn.every((b) => floors.some((f) => on(f) && f.biomeId === b.id && f.role === r))).join(', '));
  });

  it('⭐⭐ КАЖДОЕ МЕСТО КРУГА ПОКРЫТО СВОИМ БОЕВЫМ ЭТАЖОМ (замер до правки: у крипты зияли места 16–20)', () => {
    const holes: string[] = [];
    for (const b of biomesOn) {
      for (const p of places) {
        const here = availableRolesAt(b.id, floors, p);
        if (!here.has('combat')) holes.push(`${b.id}/место ${p}`);
      }
    }
    expect(holes, 'места круга без своего боевого этажа').toEqual([]);
    // Печатаем покрытие словами — чтобы правка окон была видна в выводе, а не только в падении.
    for (const b of biomesOn) {
      const mine = floors.filter((f) => on(f) && f.biomeId === b.id && f.role === 'combat');
      // eslint-disable-next-line no-console
      console.log(`Г8-5 БОЕВЫЕ ОКНА ${b.id}: ` + mine.map((f) => `${f.id} ${f.minDepth}..${f.maxDepth}`).join(' · '));
    }
  });

  it('⭐⭐ МЕСТА ЛЕСТНИЦЫ БОССОВ — В ОКНЕ БОССОВОГО ЭТАЖА (иначе босс встанет на чужом этаже молча)', () => {
    const bad: string[] = [];
    for (const b of biomesOn) {
      for (const { at, rank } of access.bossLadder) {
        const ok = floors.some((f) => on(f) && f.biomeId === b.id && f.role === 'boss' && at >= f.minDepth && at <= f.maxDepth);
        if (!ok) bad.push(`${b.id}/место ${at} (${rank})`);
      }
    }
    expect(bad, 'места боссов вне окна боссового этажа').toEqual([]);
  });

  it('⭐⭐ ЭТАЖ РЯДОВОГО УЗЛА ВЗЯТ ИЗ ОКНА, А НЕ ФОЛБЭКОМ — окна глубины перестали быть декоративными', () => {
    const r = reg();
    const out: string[] = [];
    for (const b of biomesOn) {
      for (let seed = 1; seed <= 12; seed++) {
        const plan = generateRunPlan(r, { ...defaultRunConfig(r, seed * 7919 + 13), biomeId: b.id }, undefined, { from: 1, to: 2 * CYCLE });
        for (const n of plan.nodes) {
          if (n.type === 'rest' || n.type === 'boss') continue;   // их ставит таблица круга (Г8-4), окно им не указ
          const place = bandDepth(n.depth, CYCLE);
          const f = floors.find((x) => x.id === n.floorSpec.floorId);
          if (!f) { out.push(`${b.id}/${n.id}: этаж «${n.floorSpec.floorId}» не найден`); continue; }
          if (place < f.minDepth || place > f.maxDepth) {
            out.push(`${b.id}/${n.id}: место ${place} вне окна этажа ${f.id} (${f.minDepth}..${f.maxDepth})`);
          }
        }
      }
    }
    expect(out.slice(0, 5), 'рядовые узлы вне окна своего этажа').toEqual([]);
  });

  it('⭐ ОКНО ВЫБИРАЕТ РОЛЬ: на месте 1 крипты элиты и сокровищницы нет (их окна с 3-го) — и это теперь ПРАВИЛО', () => {
    const here = availableRolesAt('crypt', floors, 1);
    expect([...here].sort(), 'роли места 1').toEqual(['combat', 'rest']);
    expect(availableRolesAt('crypt', floors, 3).has('elite'), 'с места 3 элита появляется').toBe(true);
    // И подбор этажа роли на этом месте возвращает именно его (а не ближайшее окно).
    const f = pickFloorForRole('combat', 'crypt', floors, 1, 7)!;
    expect([f.minDepth <= 1, f.maxDepth >= 1], `этаж ${f.id} накрывает место 1`).toEqual([true, true]);
    // ⚠ А у роли, чьё окно место не накрывает, подбор ВСЁ РАВНО даёт этаж (ближайший) — на этом и держалось
    // молчание: отвечать «нет» здесь нельзя, узел обязан получить этаж. Поэтому правило живёт в выборе РОЛИ.
    const e = pickFloorForRole('elite', 'crypt', floors, 1, 7)!;
    expect(e.minDepth, 'подбор элиты на месте 1 отдаёт ближайшее окно, а не пустоту').toBeGreaterThan(1);
  });
});
