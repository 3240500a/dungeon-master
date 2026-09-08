import { describe, it, expect } from 'vitest';
import { detect, summarize, DEFAULT_THRESHOLDS } from './anomaly.js';
import type { PlaySessionRow } from '../db/telemetry.js';

/**
 * Детектор аномалий (Ф3.3). Тесты здесь проверяют не «ловит ли», а РАВНОВЕСИЕ: слишком
 * чувствительное правило кладёт в очередь на разбор честных игроков, и очередь перестают
 * читать — это хуже, чем не иметь детектора вовсе.
 */
function row(over: Partial<PlaySessionRow> = {}): PlaySessionRow {
  return {
    id: '1', user_id: 'u1', char_id: 'c1', ip: '10.0.0.1',
    started_at: new Date(), ended_at: null,
    minutes: 60, kills: 100, gold: 1000, xp: 2000, items: 20, deaths: 1,
    floors: 5, actions: 500, action_mean_ms: 900, action_sd_ms: 220,
    ...over,
  };
}

describe('сигнатуры', () => {
  it('обычная сессия не помечается ничем', () => {
    expect(detect([row(), row({ user_id: 'u2', ip: '10.0.0.2' })])).toEqual([]);
  });

  it('марафон: шестнадцать часов подряд', () => {
    const f = detect([row({ minutes: 17 * 60 }), row({ user_id: 'u2', ip: '10.0.0.2' })]);
    expect(f.map((x) => x.kind)).toContain('marathon');
    expect(f.find((x) => x.kind === 'marathon')!.why).toMatch(/17\.0 ч/);
  });

  it('метроном: ровный ритм при большом числе действий', () => {
    const f = detect([row({ actions: 5000, action_sd_ms: 3 })]);
    const m = f.find((x) => x.kind === 'metronome');
    expect(m, 'ровный ритм обязан помечаться').toBeTruthy();
    expect(m!.weight, 'это самый сильный сигнал из наших').toBe(3);
  });

  it('метроном НЕ срабатывает на коротком куске — там разброс ничего не значит', () => {
    const f = detect([row({ actions: 20, action_sd_ms: 3 })]);
    expect(f.some((x) => x.kind === 'metronome')).toBe(false);
  });

  it('рой: несколько аккаунтов с одного адреса, но вес низкий', () => {
    const rows = ['u1', 'u2', 'u3', 'u4'].map((u) => row({ user_id: u, ip: '10.0.0.9' }));
    const f = detect(rows).filter((x) => x.kind === 'ip-swarm');
    expect(f).toHaveLength(4);
    // Общий интернет — обычное дело, поэтому сам по себе рой не повод для разбирательства.
    expect(f[0]!.weight).toBe(1);
    expect(f[0]!.why).toMatch(/семья или общий интернет/);
  });

  it('семья из двух аккаунтов не считается роем', () => {
    const rows = ['u1', 'u2'].map((u) => row({ user_id: u, ip: '10.0.0.9' }));
    expect(detect(rows).some((x) => x.kind === 'ip-swarm')).toBe(false);
  });

  it('выброс по ценности считается от МЕДИАНЫ, а не от среднего', () => {
    // Девять обычных игроков и один с двадцатикратным выхлопом. Среднее он бы утянул на себя,
    // медиана — нет: в этом и смысл выбора медианы.
    const crowd = Array.from({ length: 9 }, (_, i) => row({ user_id: `u${i}`, ip: `10.0.0.${i}`, gold: 1000, xp: 2000 }));
    const rich = row({ user_id: 'богач', ip: '10.0.1.1', gold: 20_000, xp: 40_000 });
    const f = detect([...crowd, rich]).filter((x) => x.kind === 'value-outlier');
    expect(f.map((x) => x.userId)).toEqual(['богач']);
  });

  it('короткие сессии не участвуют в сравнении — иначе выбросом станет каждый', () => {
    const rows = [row({ minutes: 0.5, gold: 100, xp: 100 }), row({ user_id: 'u2', ip: '10.0.0.2', minutes: 0.4 })];
    expect(detect(rows).some((x) => x.kind === 'value-outlier')).toBe(false);
  });
});

describe('очередь на разбор', () => {
  it('разные сигнатуры складываются, одна и та же повторно — нет', () => {
    const many = Array.from({ length: 5 }, () => row({ minutes: 20 * 60 }));   // пять марафонов подряд
    const one = summarize(detect(many));
    expect(one[0]!.kinds).toEqual(['marathon']);
    expect(one[0]!.score, 'пять одинаковых сигналов это по-прежнему один повод').toBe(2);
  });

  it('аккаунт с двумя разными сигнатурами поднимается выше', () => {
    const suspicious = row({ user_id: 'бот', ip: '10.9.9.9', minutes: 20 * 60, actions: 5000, action_sd_ms: 2 });
    const normal = row({ user_id: 'человек', ip: '10.0.0.2', minutes: 20 * 60 });
    const list = summarize(detect([suspicious, normal]));
    expect(list[0]!.userId).toBe('бот');
    expect(list[0]!.score).toBeGreaterThan(list[1]!.score);
    expect(list[0]!.why.length, 'у каждой пометки своё объяснение с числами').toBe(2);
  });

  it('пороги вынесены наружу и их можно ужесточить, не трогая код', () => {
    const r = row({ minutes: 10 * 60 });
    expect(detect([r]).some((x) => x.kind === 'marathon')).toBe(false);
    expect(detect([r], { ...DEFAULT_THRESHOLDS, marathonHours: 8 }).some((x) => x.kind === 'marathon')).toBe(true);
  });
});
