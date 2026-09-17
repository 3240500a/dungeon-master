import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '@dm/shared';
import {
  featureStatus, stageStatus, stageWhen, roughWhen, fillCounters, resolvePublic, unknownLinks,
  toHtml, toMarkdown, toBBCode, type PublicRoadmap, type PublicFeature,
} from './roadmapPublic.js';
import { SEED } from './roadmapSeed.js';
import type { Ctx, RoadmapDoc } from './roadmapModel.js';

/**
 * Публичный роадмап уходит к игрокам, поэтому здесь проверяются две вещи, которые нельзя увидеть
 * глазами в редакторе: статус не врёт относительно рабочего плана, и ничего внутреннего наружу не течёт.
 */

const doc = (): RoadmapDoc => ({
  milestones: [
    { id: 'A', title: 'Внутренняя веха А', goal: 'секретная цель', to: '2027-06-14', kind: 'fest',
      items: [{ id: 'a1', title: 'сделано', done: true }, { id: 'a2', title: 'не сделано' }] },
    { id: 'B', title: 'Внутренняя веха Б', goal: '', to: '2027-12',
      items: [{ id: 'b1', title: 'готово', done: true }] },
    { id: 'C', title: 'Веха В', goal: '', to: '2028-01', items: [{ id: 'c1', title: 'ничего' }] },
  ],
});
const ctx: Ctx = {};
const f = (over: Partial<PublicFeature>): PublicFeature => ({ id: 'f', text: 'возможность', ...over });

describe('статус выводится из рабочего роадмапа', () => {
  it('все ссылки готовы → готово; часть → в работе; ничего → в планах', () => {
    expect(featureStatus(f({ links: ['a1', 'b1'] }), doc(), ctx)).toBe('done');
    expect(featureStatus(f({ links: ['A'] }), doc(), ctx), 'веха наполовину').toBe('wip');
    expect(featureStatus(f({ links: ['c1'] }), doc(), ctx)).toBe('planned');
    expect(featureStatus(f({}), doc(), ctx), 'без ссылок').toBe('planned');
  });

  it('ручной статус перекрывает выведенный', () => {
    expect(featureStatus(f({ links: ['c1'], status: 'wip' }), doc(), ctx)).toBe('wip');
  });

  it('несуществующая ссылка не ломает статус и видна как опечатка', () => {
    expect(featureStatus(f({ links: ['нет-такой', 'a1'] }), doc(), ctx)).toBe('done');
    expect(unknownLinks(doc(), ['нет-такой', 'a1'])).toEqual(['нет-такой']);
  });

  it('этап: всё готово → готово, что-то начато → в работе', () => {
    expect(stageStatus(['done', 'done'])).toBe('done');
    expect(stageStatus(['done', 'planned'])).toBe('wip');
    expect(stageStatus(['planned'])).toBe('planned');
    expect(stageStatus([]), 'пустой этап не «готов»').toBe('planned');
  });
});

describe('срок для игрока — окно, а не дата', () => {
  it('сезоны и края года', () => {
    expect(roughWhen('2027-01-20')).toBe('Начало 2027');
    expect(roughWhen('2027-04')).toBe('Весна 2027');
    expect(roughWhen('2027-07')).toBe('Лето 2027');
    expect(roughWhen('2027-09-13')).toBe('Осень 2027');
    expect(roughWhen('2027-12')).toBe('Конец 2027');
  });

  it('фестиваль — точный месяц (дату объявляет Valve), остальное — окно', () => {
    const d = doc();
    expect(stageWhen({ id: 's', title: '', anchor: 'A', features: [] }, d)).toBe('Июнь 2027');
    expect(stageWhen({ id: 's', title: '', anchor: 'B', features: [] }, d)).toBe('Конец 2027');
  });

  it('без якоря берётся самая поздняя веха ссылок; ручной текст главнее', () => {
    const d = doc();
    expect(stageWhen({ id: 's', title: '', features: [f({ links: ['a1', 'c1'] })] }, d)).toBe('Начало 2028');
    expect(stageWhen({ id: 's', title: '', when: 'Скоро', anchor: 'B', features: [] }, d)).toBe('Скоро');
  });

  it('⭐ сдвиг вехи в рабочем плане сам меняет срок у игрока', () => {
    const d = doc();
    const st = { id: 's', title: '', anchor: 'B', features: [] };
    expect(stageWhen(st, d)).toBe('Конец 2027');
    d.milestones[1]!.to = '2028-03';
    expect(stageWhen(st, d)).toBe('Весна 2028');
  });
});

describe('числа в тексте', () => {
  it('ключ счётчика подставляется, без конфига — знак вопроса, чужие скобки не трогаются', () => {
    const cfg = { monsters: [1, 2, 3] };
    expect(fillCounters('{monsters} врагов', cfg)).toBe('3 врагов');
    expect(fillCounters('{monsters} врагов', undefined)).toBe('? врагов');
    expect(fillCounters('{неключ} как есть', cfg)).toBe('{неключ} как есть');
  });
});

describe('⭐ наружу не течёт внутреннее', () => {
  const seed = SEED();
  const pub = seed.public!;
  const outputs = (): string[] => {
    const r = resolvePublic(pub, seed, { config: {} });
    return [toHtml(r), toMarkdown(r), toBBCode(r)];
  };

  it('наполнение для игроков есть и каждая его ссылка ведёт в рабочий роадмап', () => {
    expect(pub.stages.length).toBeGreaterThan(3);
    for (const s of pub.stages) {
      expect(s.anchor ? seed.milestones.some((m) => m.id === s.anchor) : true, `якорь ${s.anchor}`).toBe(true);
      for (const feat of s.features) expect(unknownLinks(seed, feat.links), `«${feat.text}»`).toEqual([]);
    }
  });

  it('ни названий вех, ни описаний, ни пунктов рабочего плана в выгрузках нет', () => {
    const outs = outputs();
    const secrets = seed.milestones.flatMap((m) => [
      m.goal, ...(m.desc ?? '').split('\n').filter((l) => l.trim().length > 30), ...m.items.map((i) => i.title),
    ]).filter((s) => s.trim().length > 12);
    for (const out of outs) for (const s of secrets) expect(out.includes(s), `утекло: «${s}»`).toBe(false);
  });

  it('⚠ будущие сезоны не «в работе» от счётчиков, которые закрыл первый биом', () => {
    // Поймано живьём: сезон 2 ссылался на веху со счётчиком монстров (13 из 22 уже есть в крипте)
    // и показывался игрокам «в работе» за год до начала.
    const reg = new ConfigRegistry(); reg.loadAll();
    const config = Object.fromEntries(['monsters', 'uniques', 'models', 'items.base', 'affixes', 'skill-tree', 'mastery-tree', 'craft-materials']
      .map((k) => [k, reg.get(k as never)]));
    const r = resolvePublic(pub, seed, { config });
    pub.stages.forEach((s, i) => {
      if (['pub-demo', 'pub-ea', 'pub-s2', 'pub-s3', 'pub-s4'].includes(s.id)) expect(r.stages[i]!.status, s.title).toBe('planned');
    });
    expect(r.stages[0]!.status, 'сделанное — готово').toBe('done');
  });

  it('деньги, вишлисты и кухня Steam наружу не попадают', () => {
    for (const out of outputs()) {
      expect(out).not.toMatch(/\$|вишлист|выручк|GameDiscoverCo|App Fee|⚠/i);
    }
  });

  it('текст экранируется: HTML в формулировке не исполнится', () => {
    const evil: PublicRoadmap = { title: 'T', intro: '', disclaimer: '', stages: [{ id: 's', title: '<b>x</b>', features: [f({ text: '<script>alert(1)</script>' })] }] };
    const html = toHtml(resolvePublic(evil, doc(), ctx));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});
