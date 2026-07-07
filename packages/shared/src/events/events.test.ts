import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './index.js';

describe('EventBus', () => {
  it('доставляет payload подписчику', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('gold:changed', fn);
    bus.emit('gold:changed', { gold: 42 });
    expect(fn).toHaveBeenCalledWith({ gold: 42 });
  });

  it('off и функция-отписка снимают обработчик', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const unsub = bus.on('gold:changed', fn);
    unsub();
    bus.emit('gold:changed', { gold: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});
