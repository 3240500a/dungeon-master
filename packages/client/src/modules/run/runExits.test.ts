import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FloorInit, RunPlan, RunNode, RunNodeType } from '@dm/shared';
import { exitInteract, exitLabel } from './runExits.js';

/**
 * ⭐ C-10: ПОДПИСЬ ВЫХОДА НА РАЗВИЛКЕ — ИЗ ПЛАНА ЗАБЕГА НА МИГ ПОКАЗА, А НЕ НА МИГ ПОСТРОЙКИ ОБЛАСТИ.
 *
 * Оба веб-клиента строили интерактивы выходов один раз — в `buildArea`, по `app.run`. А сервер шлёт `joined` и `areaChanged` РАНЬШЕ
 * `runPlan` (вход в комнату, вход в узел), и город обнуляет `app.run`: на первом узле каждого забега (у 72% забегов он развилка) и на любом
 * узле после (пере)входа все выходы подписывались «Спуститься глубже», а «Спуститься: Лавка / Сокровищница / Босс» (see-ahead) не
 * появлялось, пока игрок не сменит этаж. Кадр `runPlan` интерактивы не перестраивал. Теперь подпись — чтение плана в миг показа.
 */
const node = (id: string, type: RunNodeType, to: string[]): RunNode => ({
  id, type, depth: 0, lane: 0, biomeId: 'crypt', floorSpec: {} as RunNode['floorSpec'], modifiers: [], edges: to.map((t) => ({ to: t })),
});
const PLAN: RunPlan = {
  templateId: 't', biomeId: 'crypt', tier: 'normal', seed: 1, startId: 'start', runModifiers: [],
  nodes: [node('start', 'start', ['n1_0', 'n1_1']), node('n1_0', 'shop', ['n2_0']), node('n1_1', 'boss', ['n2_0']), node('n2_0', 'combat', [])],
};
const floor = (runNodeId: string, exits: number): FloorInit => ({
  area: 'dungeon', runNodeId, exits: Array.from({ length: exits }, (_, i) => ({ x: 100 + i * 50, y: 200 })),
} as unknown as FloorInit);

describe('⭐ C-10: подпись выхода на развилке — из плана забега на миг показа', () => {
  it('⭐ выходы построены ДО кадра `runPlan` (вход в узел, (пере)вход) — пришёл план, и подписи сами стали see-ahead', () => {
    let plan: RunPlan | undefined;   // город обнулил `app.run`; `areaChanged` пришёл раньше `runPlan`
    const went: number[] = [];
    const f = floor('start', 2);
    const exits = f.exits!.map((ex, i) => exitInteract(ex, f, i, () => plan, (k) => went.push(k)));
    expect(exits.map((e) => e.label)).toEqual(['Спуститься глубже (голосование)', 'Спуститься глубже (голосование)']);
    plan = PLAN;   // кадр `runPlan` — App кладёт его в `app.run`, интерактивы не перестраивает никто
    expect(exits.map((e) => e.label), 'было: подпись застывала до смены этажа').toEqual(['Спуститься: Лавка (голосование)', 'Спуститься: Босс (голосование)']);
    expect(exits.map((e) => [e.x, e.y, e.radius])).toEqual([[100, 200, 34], [150, 200, 34]]);
    exits[1]!.run();
    expect(went, 'выход ведёт по своему ребру (номер выхода)').toEqual([1]);
  });

  it('не развилка — обычный спуск; узел берётся из этажа (где стоишь), а не из прошлого плана', () => {
    expect(exitLabel(PLAN, 'n1_0', 0)).toBe('Спуститься глубже (голосование)');
    expect(exitLabel(PLAN, 'start', 1)).toBe('Спуститься: Босс (голосование)');
    expect(exitLabel(undefined, 'start', 0)).toBe('Спуститься глубже (голосование)');
    expect(exitLabel(PLAN, undefined, 0)).toBe('Спуститься глубже (голосование)');
    expect(exitLabel(PLAN, 'start', 5), 'выхода больше, чем рёбер, — обычный спуск').toBe('Спуститься глубже (голосование)');
  });

  it('оба веб-клиента строят выходы общим `exitInteract` (подпись — чтением плана), своей подписи на постройке нет', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['../../scenes/OnlineScene.ts', '../../render3d/online3d.ts']) {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src, file).toMatch(/exitInteract\(ex, floor, i, \(\) => (this\.)?app\.run\?\.plan,/);
      expect(src, `${file}: ⚠ подпись выхода снова считается один раз — на постройке области`).not.toMatch(/label: (this\.)?exitLabel\(/);
    }
  });
});
