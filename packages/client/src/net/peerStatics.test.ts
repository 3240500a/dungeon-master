import { describe, it, expect } from 'vitest';
import type { PeerInfo } from '@dm/shared';
import { mergePeerStatics } from './peerStatics.js';

/**
 * ⭐ R2-03: статика игроков из кадра `joined`. Раньше `joined.peers` не читал никто, и вошедший позже не знал тех,
 * кто уже в комнате: они рисовались безымянным «воином» с полной полоской HP.
 */
describe('статика игроков: joined.peers и peerInfo сливаются по id', () => {
  const a = { id: 'p_a', classId: 'mage', name: 'Аня', maxHp: 90, r: 14 } as PeerInfo;
  const b = { id: 'p_b', classId: 'archer', name: 'Боря', maxHp: 80, r: 14, weaponKey: 'bow' } as PeerInfo;

  it('joined.peers заполняет статику всех, кто уже в комнате', () => {
    const statics = new Map<string, PeerInfo>();
    mergePeerStatics(statics, [a, b]);
    expect(statics.get('p_a')).toEqual(a);
    expect(statics.get('p_b')).toEqual(b);
  });

  it('неполный peerInfo (только изменившиеся, R1-11) ничего не стирает; пустой — тоже', () => {
    const statics = new Map<string, PeerInfo>();
    mergePeerStatics(statics, [a, b]);
    mergePeerStatics(statics, [{ ...a, maxHp: 120 }]);
    mergePeerStatics(statics, undefined);
    expect(statics.get('p_a')!.maxHp).toBe(120);
    expect(statics.get('p_b')).toEqual(b);
  });
});
