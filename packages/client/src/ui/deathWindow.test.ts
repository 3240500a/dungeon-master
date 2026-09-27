import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DeathWindow, type DeathDock, type DeathView, type DiedFrame } from './deathWindow.js';

/**
 * ⭐ R13-05: окно смерти — статусы (`died` с `status`) не строят его заново. Раньше сервер слал статусом `died {0, 0}` (последний живой
 * ушёл — «в город», вернулся — «ждите»), и оба клиента строили окно заново: потери «0 золота, 0 предм.» вместо настоящих, окно,
 * закрытое «Смотреть», вставало посреди экрана (у «возвращаетесь в город» — без кнопки), и так на каждую перезагрузку напарника.
 */
function win(): { w: DeathWindow; shown: DeathView[]; hidden: () => number; dock: () => DeathDock | null } {
  const shown: DeathView[] = [];
  let hides = 0;
  /** R14-03: плашка «В город» вне окна — что на экране сейчас (последний вызов `dock`). */
  let docked: DeathDock | null = null;
  const w = new DeathWindow({ show: (v) => { shown.push(v); }, hide: () => { hides++; }, dock: (v) => { docked = v; } },
    { wait: 'ждите', spectate: 'Смотреть' });
  return { w, shown, hidden: () => hides, dock: () => docked };
}
const died = (f: Partial<DiedFrame>): DiedFrame => ({ t: 'died', goldLost: 0, itemsLost: 0, toTown: false, ...f });

describe('⭐ R13-05: окно смерти и статусы', () => {
  it('смерть (350/2) → «Смотреть» → статус «в город» — окно не открывается снова, потери в памяти — настоящие', () => {
    const { w, shown } = win();
    w.onDied(died({ goldLost: 350, itemsLost: 2 }));
    expect(shown.length).toBe(1);
    expect(shown[0]!.loss).toContain('350');
    expect(shown[0]!.spectate).toBe('Смотреть');
    w.dismiss();
    w.onDied(died({ toTown: true, status: true }));
    w.onDied(died({ toTown: false, status: true }));
    expect(shown.length, 'закрытое окно статусы не открывают').toBe(1);
    expect(w.state?.losses).toEqual({ gold: 350, items: 2 });
  });

  it('окно открыто — статус «в город» меняет режим, потери те же, кнопка «Смотреть» есть', () => {
    const { w, shown } = win();
    w.onDied(died({ goldLost: 350, itemsLost: 2 }));
    w.onDied(died({ toTown: true, status: true }));
    const v = shown.at(-1)!;
    expect(v.status).toContain('город');
    expect(v.loss).toContain('350');
    expect(v.loss).toContain('2');
    expect(v.spectate, 'закрыть можно').toBeTruthy();
  });

  it('пати ждёт отвалившегося посреди боя (`canLeave`) — кнопка «В город»', () => {
    const { w, shown } = win();
    w.onDied(died({ goldLost: 10, itemsLost: 0 }));
    w.onDied(died({ status: true, canLeave: true }));
    expect(shown.at(-1)!.town).toBe('В город');
  });

  it('вошёл в комнату мёртвым (статус без смерти в памяти) — окно открыто, строки потерь нет', () => {
    const { w, shown } = win();
    w.onDied(died({ status: true }));
    expect(shown.length).toBe(1);
    expect(shown[0]!.loss).toBeUndefined();
    expect(shown[0]!.title).toBe('Вы погибли');
  });

  it('вайп (соло) — как было: окно до возврата, без «Смотреть»; новая смерть после возрождения — новое окно', () => {
    const { w, shown } = win();
    w.onDied(died({ goldLost: 5, itemsLost: 1, toTown: true }));
    expect(shown[0]!.spectate).toBeUndefined();
    w.reset();
    w.onDied(died({ goldLost: 7, itemsLost: 0 }));
    expect(shown.length).toBe(2);
    expect(shown[1]!.loss).toContain('7');
  });
});

/**
 * ⭐ R14-03: ВЫХОД НЕ ПРЯЧЕТСЯ ЗА «СМОТРЕТЬ». A погиб при живом B и закрыл окно «Смотреть» (обычный выбор), потом B отвалился посреди
 * боя: сервер ОДИН раз шлёт статус `canLeave` (пати ждёт B весь грейс, `reconnectGraceSec` — час) — а закрытое окно статусы не открывают
 * (R13-05), и кнопка «В город», единственный выход, не рисовалась нигде: ни текста, ни кнопки до часа (выход — F5 или «Завершить» со
 * штрафом за весь забег). Теперь, пока окно закрыто и выход есть, — плашка «В город» вне окна (`dock`); окно само не встаёт.
 */
describe('⭐ R14-03: «В город» после «Смотреть»', () => {
  it('смерть (350/2) → «Смотреть» → статус `canLeave` — плашка «В город» с тем же текстом режима; окно не встаёт', () => {
    const { w, shown, dock } = win();
    w.onDied(died({ goldLost: 350, itemsLost: 2 }));
    w.dismiss();
    expect(dock(), 'выхода нет — плашки нет').toBeNull();
    w.onDied(died({ status: true, canLeave: true }));
    expect(dock(), 'было: ни окна, ни кнопки — мёртвый ждал до часа').toMatchObject({ town: 'В город' });
    expect(dock()!.status).toContain('отключился посреди боя');
    expect(shown.length, 'закрытое окно статус не открывает (R13-05)').toBe(1);
    expect(w.state?.losses, 'потери в памяти — настоящие').toEqual({ gold: 350, items: 2 });
  });

  it('напарник вернулся (статус без `canLeave`) или пати уходит в город (`toTown`) — плашка прочь, окно не встаёт', () => {
    for (const next of [died({ status: true }), died({ status: true, toTown: true })]) {
      const { w, shown, dock } = win();
      w.onDied(died({ goldLost: 350, itemsLost: 2 }));
      w.dismiss();
      w.onDied(died({ status: true, canLeave: true }));
      expect(dock()).not.toBeNull();
      w.onDied(next);
      expect(dock(), JSON.stringify(next)).toBeNull();
      expect(shown.length, JSON.stringify(next)).toBe(1);
    }
  });

  it('окно открыто со статусом `canLeave` — «В город» в окне, плашки нет; «Смотреть» — плашка (закрыть окно не значит лишиться выхода)', () => {
    const { w, shown, dock } = win();
    w.onDied(died({ goldLost: 10, itemsLost: 0 }));
    w.onDied(died({ status: true, canLeave: true }));
    expect(shown.at(-1)!.town).toBe('В город');
    expect(dock(), 'окно на экране — кнопка в нём').toBeNull();
    w.dismiss();
    expect(dock()).toMatchObject({ town: 'В город' });
    // Плашка говорит то же, что окно: и что будет с отключившимся.
    expect(shown.at(-1)!.status).toContain(dock()!.status);
  });

  it('ожил / сменилась область / связь потеряна (`reset`) — плашка прочь; арена и вайп плашки не дают', () => {
    const { w, dock } = win();
    w.onDied(died({ goldLost: 10, itemsLost: 0 }));
    w.dismiss();
    w.onDied(died({ status: true, canLeave: true }));
    w.reset();
    expect(dock()).toBeNull();
    w.onDied(died({ pvp: true, canLeave: true }));
    w.dismiss();
    expect(dock(), 'арена').toBeNull();
    w.reset();
    w.onDied(died({ goldLost: 5, itemsLost: 1, toTown: true }));
    w.dismiss();
    expect(dock(), 'вайп: пати и так уходит в город').toBeNull();
  });
});

describe('⭐ R13-05: оба онлайн-клиента ведут окно смерти через `DeathWindow`', () => {
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  for (const rel of ['../render3d/online3d.ts', '../scenes/OnlineScene.ts']) {
    it(rel, () => {
      const code = src(rel);
      expect(code, 'кадр `died` — в окно смерти').toMatch(/on\('died',\s*\(f\)\s*=>\s*[\w.]*death\w*\.onDied\(f\)\)/i);
      expect(code, 'смена области — окно смерти сброшено').toMatch(/on\('areaChanged',\s*\(f\)\s*=>\s*\{[^}]*death\w*\.reset\(\)/i);
      // ⭐ R14-03: плашка «В город» вне окна — у обоих клиентов, и её кнопка шлёт `return`.
      expect(code, 'плашка выхода подключена к окну смерти').toMatch(/new DeathWindow\(\{[^}]*dock:\s*\(v\)\s*=>\s*[\w.]*showDeathDock\(v\)/);
      const dockFn = code.slice(code.search(/(function |private )showDeathDock\(/));
      expect(dockFn.slice(0, 1500), 'кнопка плашки уводит в город').toMatch(/addEventListener\('click',\s*\(\)\s*=>\s*[\w.]*net\.send\(\{ t: 'return' \}\)\)/);
    });
  }
});
