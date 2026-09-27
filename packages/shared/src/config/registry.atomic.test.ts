import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { EventBus } from '../events/index.js';

/**
 * ⭐ R7-14: `reload` КЛАДЁТ ВСЁ ИЛИ НИЧЕГО. Таблицы разбирались и клались по одной: первая негодная бросала, а те, что до
 * неё, уже стояли новые — реестр оставался смесью двух конфигов (клиент после деплоя со сменой схемы считал цены по смеси,
 * сервер отказывал «Цена изменилась»). Теперь всё разбирается в сторонке и кладётся, только если годно всё; негодное —
 * прежний конфиг цел, `config:reloaded` не звучит, а ошибка по-прежнему называет таблицу.
 */
describe('⭐ R7-14: ConfigRegistry.reload — атомарно', () => {
  it('⭐ годная таблица перед негодной не ложится; неизвестная таблица — так же; событие — только на успех', () => {
    const bus = new EventBus();
    const heard: string[][] = [];
    bus.on('config:reloaded', (p) => { heard.push(p.keys); });
    const r = new ConfigRegistry(bus);
    r.loadAll();
    const before = r.get('balance').respecCost;
    const balance = { ...r.get('balance'), respecCost: before + 1 };

    expect(() => r.reload({ balance, rarities: [{ broken: true }] } as Record<string, unknown>)).toThrow(/rarities/);
    expect(r.get('balance').respecCost, 'было: balance уже новый').toBe(before);
    expect(() => r.reload({ balance, 'craft-new-table': [] } as Record<string, unknown>)).toThrow();
    expect(r.get('balance').respecCost).toBe(before);
    expect(heard, 'негодное — события нет').toEqual([]);

    r.reload({ balance });
    expect(r.get('balance').respecCost).toBe(before + 1);
    expect(heard).toEqual([['balance']]);
  });

  it('loadAll — так же: негодная таблица в конце не оставляет новыми те, что до неё', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    const before = r.get('balance').respecCost;
    const raw = structuredClone(r.snapshot()) as unknown as Record<string, unknown>;
    (raw.balance as { respecCost: number }).respecCost = before + 1;
    raw.rarities = [{ broken: true }];
    expect(() => r.loadAll(raw)).toThrow(/rarities/);
    expect(r.get('balance').respecCost).toBe(before);
  });
});
