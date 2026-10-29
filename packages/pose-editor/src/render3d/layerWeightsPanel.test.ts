import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { layerTrace } from './poseRuntime.js';
import { createLayerWeightsPanel, type LayerPanel } from './layerWeightsPanel.js';
import { lookupLayers, resolveLayers, newResolvedLayers, lookupItemSwing, swingDefault, type LayerStore, type SwayStore, type SwingStore } from './layerWeights.js';

/**
 * ПАНЕЛЬ ВЕСОВ СЛОЁВ (вкладки «Тест» и «Бег») — сторож поведения.
 *
 * DOM-окружения в проекте нет (тесты идут в node), поэтому вместо него — заглушка ровно тех свойств, которыми панель
 * пользуется. Этого хватает для главного: ЧТО панель пишет в `pe_layers` и ПОД КАКИМ КЛЮЧОМ. Вид — глазами автора.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; title = ''; type = ''; min = ''; max = ''; step = ''; value = '';
  onclick: (() => void) | null = null; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
  isConnected = true;
  constructor(public tag: string) { }
  append(...c: El[]): void { this.children.push(...c); }
  replaceChildren(...c: El[]): void { this.children = [...c]; }
  remove(): void { this.isConnected = false; }
  /** Все потомки в порядке обхода. */
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.textContent, ...this.all().map((c) => c.textContent)].join(' | '); }
}
const G = globalThis as unknown as { document?: unknown; confirm?: unknown };
beforeAll(() => { G.document = { createElement: (t: string) => new El(t) }; G.confirm = () => true; });
afterAll(() => { delete G.document; delete G.confirm; layerTrace.on = false; });

let layers: LayerStore, sway: SwayStore, swing: SwingStore, hands: { main: string; off: string }, saves: number, weapon: string, panel: LayerPanel;
const root = (): El => panel.el as unknown as El;
const sliders = (): El[] => root().all().filter((e) => e.tag === 'input');
const button = (part: string): El => root().all().find((e) => e.tag === 'button' && e.textContent.includes(part))!;
/** Четыре ползунка: две части (грудь, голова) × ходьба/бег, в порядке `LAYER_PARTS`. «грудь · бег» = 0·2 + 1. */
const ARM_R_RUN = 1, ARM_R_WALK = 0;
const drag = (i: number, v: number): void => { const s = sliders()[i]!; s.value = String(v); s.oninput!(); s.onchange!(); };
const eff = (w: string, sb: number, combat = 0): ReturnType<typeof newResolvedLayers> => {
  const lk = lookupLayers(layers, sway, 'warrior', w);
  return resolveLayers(lk.entry, sb, combat, lk.swing, 0, newResolvedLayers());
};
/** Все панели теста снимаются: подписка на трассу — счётчик, и забытая панель держала бы трассу включённой. */
const made: LayerPanel[] = [];
const open = (live: boolean): LayerPanel => {
  const p = createLayerWeightsPanel({ charId: () => 'warrior', weapon: () => weapon, layers: () => layers, sway: () => sway,
    swing: () => swing, hands: () => hands, save: () => { saves++; }, live });
  made.push(p); return p;
};
beforeEach(() => {
  layers = {}; sway = { warrior: { none: 0.5 } }; swing = {}; hands = { main: 'sword', off: 'shield' }; saves = 0; weapon = 'sword+shield';
  panel = open(true);
});
afterEach(() => { for (const p of made.splice(0)) p.dispose(); });

describe('панель весов слоёв', () => {
  it('⭐ ПОД МЕЧОМ СО ЩИТОМ ПОЛЗУНКИ ЕСТЬ — и говорят, что действует умолчание 0.2', () => {
    // Прежний одиночный ползунок рисовался только у точного ключа с клипом стойки: у `sword+shield` его не было вовсе.
    // ⚠ Рук здесь больше нет: они резолвятся по ПРЕДМЕТУ в руке (`pe_swing`, своя панель). Осталась грудь и голова,
    // у которой своё умолчание — в игре ею владеет стойка.
    // 4 у частей (грудь, голова × ходьба/бег) + на каждую ЗАНЯТУЮ руку по ТРИ строки: «мах» и две поправки
    // направления («вбок ×», «назад ×»). Направление не прячется под «подробно» НАРОЧНО: автор просил его явно.
    expect(sliders()).toHaveLength(10);
    expect(sliders().slice(0, 4).map((s) => s.value)).toEqual(['0.2', '0.2', '0', '0']);
    expect(root().text()).toContain('действует умолчание 0.2');
    expect(root().text()).toContain('правится ОБЩАЯ запись «sword»');
  });

  it('⭐ ПОЛЗУНОК ПИШЕТ В ОБЩУЮ ЗАПИСЬ МЕЧА — она действует и без щита; остальные части не сброшены', () => {
    drag(ARM_R_RUN, 0.8);
    expect(layers.warrior!.sword!.run!.chest).toBe(0.8);
    expect(layers.warrior!['sword+shield'], 'своя запись под щит сама не заводится').toBeUndefined();
    expect(saves).toBeGreaterThan(0);
    expect(eff('sword+shield', 1)).toMatchObject({ chest: 0.8 });
    expect(eff('sword', 1).chest, 'и голый меч получил тот же вес').toBe(0.8);
    expect(eff('sword+shield', 0).chest, 'ходьба не тронута').toBe(0.2);
    expect(sliders()[ARM_R_RUN]!.value, 'после перерисовки ползунок показывает записанное').toBe('0.8');
  });

  it('⭐ «ОТДЕЛИТЬ СВОЮ» заводит запись под точным ключом КОПИЕЙ действующей; дальше правится она, меч не трогается', () => {
    drag(ARM_R_RUN, 0.8);
    button('отделить свою').onclick!();
    expect(layers.warrior!['sword+shield']!.run!.chest).toBe(0.8);
    expect(root().text()).toContain('правится СВОЯ запись «sword+shield»');
    drag(ARM_R_RUN, 0.3);
    expect(eff('sword+shield', 1).chest).toBe(0.3);
    expect(eff('sword', 1).chest, 'меч без щита остался при своих 0.8').toBe(0.8);
    button('снять свою').onclick!();
    expect(layers.warrior!['sword+shield']).toBeUndefined();
    expect(eff('sword+shield', 1).chest, 'вернулась общая запись меча').toBe(0.8);
  });

  it('⭐ ПЕРВОЕ КАСАНИЕ НЕ СБРАСЫВАЕТ ОСТАЛЬНОЕ И НЕ ПЛОДИТ ЗАПИСЕЙ: у `none` действовало 0.5 — прочие части его наследуют', () => {
    weapon = 'none';
    panel = open(false);
    expect(root().text()).toContain('одно число на весь верх — 0.50');
    drag(ARM_R_WALK, 0.9);
    expect(eff('none', 0)).toMatchObject({ chest: 0.9, head: 0 });
    expect(layers.warrior!.none, 'запись разрежённая: в ней только тронутая ячейка').toEqual({ walk: { chest: 0.9 } });
    expect(root().all().filter((e) => e.textContent === '↺'), 'и «своей» помечена она одна').toHaveLength(1);
  });

  it('колонка БОЯ: без своей записи показывает релакс; запись боя релакс не трогает; ↺ снимает только её', () => {
    drag(ARM_R_RUN, 0.8);
    button('бой').onclick!();
    expect(sliders()[ARM_R_RUN]!.value, 'бой наследует релакс').toBe('0.8');
    drag(ARM_R_RUN, 0.1);
    expect(eff('sword', 1, 1).chest).toBe(0.1);
    expect(eff('sword', 1, 0).chest, 'релакс остался').toBe(0.8);
    // ↺ — третий ребёнок строки ползунка (ползунок, значение, сброс).
    const rst = root().all().filter((e) => e.textContent === '↺');
    expect(rst.length, 'своя запись в бою одна').toBe(1);
    rst[0]!.onclick!();
    expect(layers.warrior!.sword!.combat, 'пустая колонка боя убрана').toBeUndefined();
    expect(eff('sword', 1, 1).chest).toBe(0.8);
  });

  it('живые доли берутся ИЗ ТРАССЫ рантайма (панель сама ничего не считает); уход со вкладки снимает подписку', () => {
    expect(layerTrace.on, 'панель с живыми долями подписана на трассу').toBe(true);
    layerTrace.t = Date.now(); layerTrace.speed = 118; layerTrace.sb = 1; layerTrace.combat = 0;
    layerTrace.rows = [{ layer: '↳ грудь', src: 'клип хода', w: 0.62, note: 'вес 0.80 × ход 0.78' }];
    panel.update();
    expect(root().text()).toContain('ход 62 %');
    expect(root().text()).toContain('118 ед/с · бег 100 %');
    layerTrace.t = 0;
    panel.update();
    expect(root().text(), 'застывшую трассу панель за живую не выдаёт').toContain('кукла не шагает');
    panel.dispose();
    expect(layerTrace.on).toBe(false);
    layerTrace.rows = [];
  });

  it('⭐⭐ МАХ РУК: ползунок пишет по ПРЕДМЕТУ, а не по ключу оружия; пустая рука ручек не имеет вовсе', () => {
    // «Мах · бег» правой (меч) — пятый ползунок: 4 у частей, потом по ТРИ на занятую руку
    // (мах, вбок ×, назад ×). Берём только строки МАХА — поправки направления проверяет .
    const armSliders = sliders().slice(4).filter((_, i) => i % 3 === 0);
    expect(armSliders).toHaveLength(2);           // меч в правой + щит в левой
    armSliders[0]!.value = '0.9'; armSliders[0]!.oninput!(); armSliders[0]!.onchange!();
    expect(swing.warrior!.sword!.run!.arm!.k, 'запись легла под ПРЕДМЕТ «sword»').toBe(0.9);
    expect(swing.warrior!.shield, 'щит не тронут — у него свой ключ').toBeUndefined();
    expect(lookupItemSwing(swing, 'warrior', 'sword', 1, 0).arm.k).toBe(0.9);

    hands = { main: 'sword', off: 'none' };       // щит сняли — левая рука пуста
    panel.dispose(); panel = open(true);
    // три строки на ОДНУ занятую руку (мах + вбок × + назад ×); у пустой — ни одной
    expect(sliders().slice(4), 'у пустой руки ручек нет: её ведёт клип целиком').toHaveLength(3);
    expect(root().text()).toContain('пусто — машет как в клипе');
  });

  it('значение без своей записи подписано УМОЛЧАНИЕМ КЛАССА, а не молчит; ↺ его возвращает', () => {
    const arm = sliders()[4]!;
    expect(arm.value).toBe(String(swingDefault('sword').arm.k));
    arm.value = '0.15'; arm.oninput!(); arm.onchange!();
    expect(root().all().filter((e) => e.textContent === '↺').length, 'своя запись помечена').toBeGreaterThan(0);
    button('вернуть умолчания').onclick!();
    expect(swing.warrior!.sword).toBeUndefined();
    expect(sliders()[4]!.value).toBe(String(swingDefault('sword').arm.k));
  });

  it('живой «мах NN %» у руки берётся из строки трассы этой руки', () => {
    layerTrace.t = Date.now(); layerTrace.sb = 1;
    layerTrace.rows = [{ layer: '↳ рука П', src: 'клип хода + «sword»', w: 0.42, note: 'мах 0.42' }];
    panel.update();
    expect(root().text()).toContain('мах 42 %');
    layerTrace.rows = [];
  });

  it('«снести веса целиком» возвращает умолчание', () => {
    drag(ARM_R_RUN, 0.8);
    button('снести веса').onclick!();
    expect(layers.warrior!.sword).toBeUndefined();
    expect(eff('sword+shield', 1).chest).toBe(0.2);
  });
});
