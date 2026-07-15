import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { EventBus } from '../events/index.js';

describe('ConfigRegistry', () => {
  it('загружает и валидирует все встроенные конфиги', () => {
    const reg = new ConfigRegistry();
    expect(() => reg.loadAll()).not.toThrow();
    expect(reg.get('classes')).toHaveLength(7);
    expect(reg.get('balance').xpTable[0]).toBe(0);
  });

  it('reload эмитит config:reloaded с изменёнными ключами', () => {
    const bus = new EventBus();
    const reg = new ConfigRegistry(bus);
    reg.loadAll();
    let received: string[] = [];
    bus.on('config:reloaded', (p) => (received = p.keys));
    reg.reload({ balance: { ...reg.get('balance'), respecCost: 999 } });
    expect(received).toEqual(['balance']);
    expect(reg.get('balance').respecCost).toBe(999);
  });

  it('бросает на невалидном конфиге', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    expect(() => reg.reload({ balance: { broken: true } })).toThrow();
  });
});
