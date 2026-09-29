import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, allocAttr, newCharacterSave, respec, unequip, type SaveState, type TownCommand } from '@dm/shared';
import type { App } from '../../core/app.js';
import { respecAttrsButton } from './respecAttrs.js';

/**
 * ⚠ R6-11: «Сбросить атрибуты (500 золота)». Кнопка была живой всегда и слала команду сразу: окно перерисовывается лишь по
 * `saveUpdate`, и двойной клик уходил двумя командами — вторая платила 500 за ничто (ядро теперь отказывает, но кнопка не
 * должна и просить). Свежий герой платил за пустое место. Теперь: погашена, когда сбрасывать нечего; спрашивает; пока
 * команда в полёте — вторую не шлёт.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется кнопка.
 */
class El {
  style: Record<string, string> = {}; textContent = ''; disabled = false; title = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  click(): void { if (!this.disabled) for (const f of this.on.get('click') ?? []) f(); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const cost = reg.get('balance').respecCost;

/** Приложение-заглушка: запросы копятся, ответ — вручную (`answer`). */
function fakeApp(save: SaveState) {
  const sent: TownCommand[] = [];
  const logs: string[] = [];
  let answer: (r: { ok: boolean; reason?: string } | null) => void = () => {};
  const app = {
    config: reg,
    state: { save },
    request: (c: TownCommand) => { sent.push(c); return new Promise((res) => { answer = res; }); },
    bus: { emit: (ev: string, p: { text?: string }) => { if (ev === 'log:message' && p.text) logs.push(p.text); } },
  } as unknown as App;
  return { app, sent, logs, answer: (r: { ok: boolean; reason?: string } | null) => answer(r) };
}

describe('⚠ R6-11: кнопка сброса атрибутов', () => {
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let asked = 0;
  beforeEach(() => {
    asked = 0;
    G.document = { createElement: (t: string) => new El(t) };
    G.window = { confirm: () => { asked++; return true; } };
  });
  afterEach(() => { delete G.document; delete G.window; });

  it('⭐ атрибуты — стартовые класса: кнопка погашена, клик не шлёт ничего', () => {
    const save = newCharacterSave(reg, 'warrior', 'Новичок', 'r611-c1');
    save.gold = cost * 10;
    const { app, sent } = fakeApp(save);
    const b = respecAttrsButton(app) as unknown as El;
    expect(b.disabled, 'сбрасывать нечего').toBe(true);
    b.click();
    expect(sent).toEqual([]);
  });

  it('⭐ двойной клик: одна команда (с ценой кнопки) и одно подтверждение; ответ пришёл — снова доступна', async () => {
    const save = newCharacterSave(reg, 'warrior', 'Двойной', 'r611-c2');
    save.gold = cost * 10;
    save.unspentAttributePoints = 5;
    expect(allocAttr(save, 'strength', 5).ok).toBe(true);
    const { app, sent, answer } = fakeApp(save);
    const b = respecAttrsButton(app) as unknown as El;
    expect(b.disabled).toBe(false);
    b.click();
    b.click();
    const again = respecAttrsButton(app) as unknown as El;   // перерисовка окна, пока команда в полёте
    expect(again.disabled, 'в полёте — погашена и после перерисовки').toBe(true);
    again.click();
    expect(sent, 'ушла одна команда').toEqual([{ cmd: 'respec', maxGold: cost }]);
    expect(asked, 'и одно подтверждение').toBe(1);
    answer({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    expect((respecAttrsButton(app) as unknown as El).disabled, 'ответ пришёл — кнопка снова живая').toBe(false);
  });

  it('отказ сервера — строкой в лог; «нет» в подтверждении — команды нет', async () => {
    const save = newCharacterSave(reg, 'warrior', 'Отказ', 'r611-c3');
    save.gold = cost * 10;
    save.unspentAttributePoints = 1;
    expect(allocAttr(save, 'vitality', 1).ok).toBe(true);
    const { app, sent, logs, answer } = fakeApp(save);
    G.window = { confirm: () => false };
    (respecAttrsButton(app) as unknown as El).click();
    expect(sent, 'отменено в вопросе').toEqual([]);
    G.window = { confirm: () => true };
    (respecAttrsButton(app) as unknown as El).click();
    answer({ ok: false, reason: 'Недостаточно золота' });
    await Promise.resolve(); await Promise.resolve();
    expect(logs).toEqual(['Не вышло: Недостаточно золота']);
  });

  /**
   * ⭐ R19-07: «ГОРИТ ⇒ СЕРВЕР СБРОСИТ». Кнопка смотрела только на возврат и золото, а ядро `respec` отказывает и тогда, когда надетое держится
   * на вложенных очках (R4-08): воин вложил очки в Силу ради оружия — кнопка горела, спрашивала «Вернётся 45 очк., цена 500 зол.», а в лог
   * приходило «Не вышло: После сброса не хватит атрибутов на «…» — сперва сними её». Теперь погашена, и подсказка — та же причина, что у сервера.
   */
  it('⭐ R19-07: надетое держится на вложенных очках — погашена с причиной сервера, команды нет; снял вещь — снова горит', () => {
    const save = newCharacterSave(reg, 'warrior', 'Силач', 'r1907-c1');
    save.gold = cost * 10;
    save.level = 10;
    save.unspentAttributePoints = 45;
    expect(allocAttr(save, 'strength', 45).ok).toBe(true);
    const weapon = save.equipment.weapon!;
    weapon.requirements = { ...weapon.requirements, strength: save.attributes.strength };   // оружие, ради которого вкладывал
    const server = respec(reg, structuredClone(save), cost);
    expect(server.ok, 'ядро отказывает — вещь без опоры').toBe(false);
    const { app, sent } = fakeApp(save);
    const b = respecAttrsButton(app) as unknown as El;
    expect(b.disabled, 'было: горела — и сброс кончался отказом').toBe(true);
    expect(b.title, 'подсказка — причина сервера').toBe(server.reason);
    b.click();
    expect(sent, 'ни вопроса, ни команды').toEqual([]);
    expect(asked).toBe(0);
    expect(unequip(reg, save, 'weapon').ok).toBe(true);
    const again = respecAttrsButton(app) as unknown as El;
    expect(again.disabled, 'вещь снята — сбрасывать можно').toBe(false);
    expect(respec(reg, structuredClone(save), cost).ok, 'и сервер сбросит').toBe(true);
    again.click();
    expect(sent).toEqual([{ cmd: 'respec', maxGold: cost }]);
  });

  it('R19-07: не хватает золота — погашена с причиной сервера', () => {
    const save = newCharacterSave(reg, 'warrior', 'Бедняк', 'r1907-c2');
    save.gold = cost - 1;
    save.unspentAttributePoints = 3;
    expect(allocAttr(save, 'vitality', 3).ok).toBe(true);
    const b = respecAttrsButton(fakeApp(save).app) as unknown as El;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(respec(reg, structuredClone(save), cost).reason);
  });
});
