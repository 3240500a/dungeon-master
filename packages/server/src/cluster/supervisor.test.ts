import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { childGone, stopChildren, nodeCount, MAX_NODES } from './supervisor.js';

afterEach(() => { vi.useRealTimers(); });

/** Ребёнок-процесс для теста: как `ChildProcess` — `killed` ставится при ОТПРАВКЕ сигнала, коды — при выходе. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  sent: string[] = [];
  kill(sig: NodeJS.Signals = 'SIGTERM'): boolean { this.killed = true; this.sent.push(sig); return true; }
  exit(code: number): void { this.exitCode = code; this.emit('exit', code, null); }
}

/**
 * ⭐ R5-08: СУПЕРВИЗОР ЖДЁТ ВЫХОДА НОД, А НЕ ОТПРАВКИ СИГНАЛА. Проверка `proc.killed` истинна сразу после `kill()`: через
 * 200 мс супервизор выходил, а systemd добивал ноды, ещё дописывавшие сейвы.
 */
describe('⭐ R5-08: остановка кластера ждёт выхода нод', () => {
  it('сигнал отправлен (`killed`), а нода ещё пишет — супервизор не выходит; вышла — выходит один раз', () => {
    vi.useFakeTimers();
    const a = new FakeChild(), b = new FakeChild();
    const done = vi.fn();
    stopChildren([a, b] as never, done, 12_000);
    expect(a.sent).toEqual(['SIGTERM']);
    expect(a.killed && childGone(a as never), '`killed` — не выход').toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(done).not.toHaveBeenCalled();
    a.exit(0);
    expect(done).not.toHaveBeenCalled();
    b.exit(0);
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(done, 'срок после выхода ничего не делает').toHaveBeenCalledTimes(1);
  });

  it('нода не вышла к сроку — SIGKILL ей, и выход', () => {
    vi.useFakeTimers();
    const a = new FakeChild();
    const done = vi.fn();
    stopChildren([a] as never, done, 12_000);
    vi.advanceTimersByTime(12_000);
    expect(a.sent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('вышедшая по сигналу нода (код null, сигнал есть) — вышла', () => {
    const a = new FakeChild();
    a.signalCode = 'SIGTERM';
    expect(childGone(a as never)).toBe(true);
    expect(childGone(undefined)).toBe(true);
  });
});

/**
 * ⭐ R5-14: БУКВ В КОДЕ КОМНАТЫ — 26, НОД — НЕ БОЛЬШЕ. По умолчанию супервизор поднимал «ядра минус два» до 32 нод: на
 * 32-поточной машине node-26…29 выдавали коды на A…D — те же буквы, что node-0…3, и вход к другу уходил не на ту ноду.
 */
describe('⭐ R5-14: число нод — не больше букв кода комнаты', () => {
  it('по умолчанию — ядра минус два, но не больше 26 и не меньше одной', () => {
    expect(MAX_NODES).toBe(26);
    expect(nodeCount(undefined, 32)).toBe(26);
    expect(nodeCount(undefined, 64)).toBe(26);
    expect(nodeCount(undefined, 8)).toBe(6);
    expect(nodeCount(undefined, 2)).toBe(1);
    expect(nodeCount('12', 64)).toBe(12);
  });

  it('DM_NODES больше 26 — запуск падает громко, а не делит буквы', () => {
    expect(() => nodeCount('27', 64)).toThrow(/26/);
    expect(() => nodeCount('30', 4)).toThrow();
  });
});
