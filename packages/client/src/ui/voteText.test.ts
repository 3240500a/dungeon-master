import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigRegistry } from '@dm/shared';
import { voteQuestion, type VoteStartFrame } from './voteText.js';
import { runNodeLabel } from '../modules/run/runLabels.js';

/**
 * ⭐ R9-08: окно голосования за спуск из города говорит, что начнётся: тир (и закрыт ли он своему герою), шаблон, биом,
 * модификаторы, продолжение чьего забега и с какого этажа. Раньше — только «Спуск на след. этаж?».
 */
let cfg: ConfigRegistry;
beforeAll(() => { cfg = new ConfigRegistry(); cfg.loadAll(); });
const nameOf = (key: 'difficulties' | 'run-templates' | 'biomes' | 'run-modifiers', id: string): string =>
  (cfg.get(key) as { id: string; name: string }[]).find((x) => x.id === id)!.name;
const base: VoteStartFrame = { t: 'voteStart', kind: 'descend', by: 'p1', needed: 2 };

describe('⭐ R9-08: вопрос окна голосования', () => {
  it('новый «кошмар» по «глубокой экспедиции» — в тексте тир, шаблон, биом и модификатор; герою без открытий — предупреждение', () => {
    const mod = cfg.get('run-modifiers')[0]!.id;
    const f: VoteStartFrame = { ...base, difficultyId: 'nightmare', templateId: 'deep-expedition', biomeId: 'crypt', modifiers: [mod] };
    const text = voteQuestion(f, cfg, {});
    expect(text).toContain('Новый забег');
    for (const [k, id] of [['difficulties', 'nightmare'], ['run-templates', 'deep-expedition'], ['biomes', 'crypt'], ['run-modifiers', mod]] as const) {
      expect(text, `${k}: ${id}`).toContain(nameOf(k, id));
    }
    expect(text, 'тир закрыт — сказано прямо').toContain('вам ещё не открыта');
    expect(voteQuestion(f, cfg, { easy: 99, normal: 99, hard: 99 }), 'открыт — без предупреждения').not.toContain('не открыта');
  });

  it('продолжение забега — имя хозяина и этаж; ник экранирован', () => {
    const f: VoteStartFrame = { ...base, difficultyId: 'easy', templateId: 'crypt-short', biomeId: 'crypt', modifiers: [], resume: { host: '<b>Ник</b>', depth: 4 } };
    const text = voteQuestion(f, cfg, {});
    expect(text).toContain('Продолжить забег &lt;b&gt;Ник&lt;/b&gt; с этажа 4');
    expect(text).toContain(nameOf('difficulties', 'easy'));
  });

  it('контроль: спуск без цели (кадр старого сервера) и прочие голосования — как прежде', () => {
    expect(voteQuestion(base, cfg)).toBe('Спуск на след. этаж?');
    expect(voteQuestion({ ...base, kind: 'town' }, cfg)).toBe('Вернуться в город?');
    expect(voteQuestion({ ...base, kind: 'arena' }, cfg)).toBe('Войти в PvP-арену?');
  });
});

/**
 * ⭐ R16-04: ГОЛОСОВАНИЕ В ПОДЗЕМЕЛЬЕ ТОЖЕ ГОВОРИТ, КУДА ВЕДЁТ. Окно напарника на развилке читало «Спуск на след. этаж?», хотя зовущий
 * звал «Спуск: Босс» (подпись выхода, C-10), а на финале тем же текстом звали ЗАВЕРШИТЬ забег — принявший уходил в город, и всё, что
 * лежало на полу финала, пропадало со сменой области. Кадр несёт тип узла цели (`targetNodeType`) и `finish` финала.
 */
describe('⭐ R16-04: вопрос окна голосования в подземелье', () => {
  it('развилка: в тексте — тип узла, куда ведёт выход зовущего (та же подпись, что у выхода и на карте забега)', () => {
    for (const t of ['boss', 'rest', 'shop', 'treasure'] as const) {
      const text = voteQuestion({ ...base, targetNodeId: 'n7', targetNodeType: t }, cfg);
      expect(text, `было: «Спуск на след. этаж?» — ${t}`).toContain(runNodeLabel(t));
      expect(text).not.toBe('Спуск на след. этаж?');
    }
  });

  it('финал: окно спрашивает о завершении забега и возврате в город, а не о спуске', () => {
    const text = voteQuestion({ ...base, finish: true }, cfg);
    expect(text, 'было: «Спуск на след. этаж?»').toContain('Завершить');
    expect(text).toContain('город');
    expect(text).not.toContain('Спуск');
  });

  it('неизвестный тип узла (конфиг новее клиента) — сам id, экранированный', () => {
    expect(voteQuestion({ ...base, targetNodeId: 'n7', targetNodeType: '<i>x</i>' }, cfg)).toContain('&lt;i&gt;x&lt;/i&gt;');
  });
});
