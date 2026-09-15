import { describe, it, expect } from 'vitest';
import { idleEndsSource, migrateClip } from './clipModel.js';
import type { Clip, Pose } from './clipModel.js';

/**
 * ⭐ КОНЦЫ КЛИПА СИНКАЮТСЯ С ТОЙ БАЗОЙ, К КОТОРОЙ КЛИП И ПРИВЯЗАЛИ.
 *
 * Жалоба: «загрузил клип, настроил, выбираю БОЕВУЮ idle-стойку меча — при загрузке показывает
 * верно, — сохраняю, а сохраняется с какой-то другой, НЕбоевой стойкой; кажется, там что-то
 * захардкожено».
 *
 * Так и было: панель импорта даёт выбрать базу (`idle` / `combat` / любой клип), запекание её
 * честно использует — поэтому превью верное, — а на сохранении `syncAttackEnds` брал
 * ВСЕГДА `stanceClip(weapon)`, то есть обычную стойку, и переписывал ею первый и последний кадр.
 *
 * ⚠ Отметка обязана переживать `migrateClip`: тот собирает клип по ЯВНОМУ списку полей и молча
 * терял бы новое поле на первом же чтении с сервера (ровно эта грабля уже была с `marks`).
 */
describe('база концов клипа', () => {
  const P = (x: number): Pose => ({ Hips: [x, 0, 0] } as unknown as Pose);
  const look = {
    stance: (w: string, combat: number): Pose | null => (combat > 0.5 ? P(11) : P(1)),
    clip: (nm: string): Pose | null => (nm === 'мой_клип' ? P(7) : null),
  };
  const clip = (from?: string): Clip =>
    ({ name: 'imported', character: 'warrior', weapon: 'sword', loop: false, keys: [], idleEnds: true, idleEndsFrom: from }) as Clip;

  it('⭐ выбрана БОЕВАЯ — синкаем боевой, а не обычной', () => {
    // ⚠ Мутация «всегда обычная стойка» (как было) валит именно это.
    expect(idleEndsSource(clip('combat'), look)).toEqual(P(11));
  });

  it('выбрана обычная — обычной', () => {
    expect(idleEndsSource(clip('idle'), look)).toEqual(P(1));
  });

  it('выбран КЛИП — его первым кадром', () => {
    expect(idleEndsSource(clip('clip:мой_клип'), look)).toEqual(P(7));
  });

  it('⚠ отметки нет (старые клипы и удары) — поведение прежнее: обычная стойка', () => {
    expect(idleEndsSource(clip(undefined), look)).toEqual(P(1));
  });

  it('⚠ отметка переживает migrateClip (иначе теряется на первом чтении с сервера)', () => {
    const m = migrateClip({ name: 'x', character: 'warrior', weapon: 'sword', keys: [], idleEnds: true, idleEndsFrom: 'combat' });
    expect(m.idleEndsFrom, '⚠ новое поле не дописано в migrateClip — выбор базы потеряется').toBe('combat');
  });
});
