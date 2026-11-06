import { describe, it, expect } from 'vitest';
import { ConfigRegistry, defaultConfigData, pseudoLocales, textLang, tr, SOURCE_LANG } from '@dm/shared';
import { inTextLang, scopeCodeOf } from './textScope.js';
import { tickScheduler } from './scheduler.js';

/**
 * ⭐ i18n Ф1 (ревизия 06.11): ТИК ПЛАНИРОВЩИКА — ВНЕ ОБЛАСТИ ЯЗЫКА. Планировщик один на процесс и заводит свою цепочку `setTimeout` в том
 * контексте, где его разбудили: первый вход в комнату (`new Room` → `tickScheduler.add`) или реконнект — это область языка ИГРОКА
 * (`RoomManager.inConnLang`). AsyncLocalStorage наследуется таймерами, и без выхода из области ВСЕ тики всех комнат процесса шли бы на
 * языке того, кто разбудил планировщик (и с журналом кодов его команды): «без области — язык-источник» (`textScope.ts`) было бы неправдой.
 */
describe('⭐ i18n Ф1 (ревизия): тик планировщика не наследует область языка того, кто его разбудил', () => {
  it('разбуженный в области `xx` (вход игрока) — шагает комнаты на языке-источнике и без журнала кодов', async () => {
    const cfg = new ConfigRegistry();
    cfg.loadAll();
    const xx = pseudoLocales(cfg.get('locales'), defaultConfigData);
    const seen: string[] = [];
    const room = { step: (): void => { const t = tr('srv:room.tooOften', 'Слишком часто'); seen.push(`${textLang()}|${t}|${scopeCodeOf(t) ?? '-'}`); } };
    expect(tickScheduler.size, 'планировщик спит').toBe(0);
    inTextLang(xx, 'xx', () => {
      expect(textLang(), 'область стоит').toBe('xx');
      expect(tr('srv:room.tooOften', 'Слишком часто'), 'и переводит').not.toBe('Слишком часто');
      tickScheduler.add(room);
    }, new Map());
    try {
      const end = Date.now() + 3000;
      while (seen.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    } finally {
      tickScheduler.remove(room);
    }
    expect(seen.length, 'тики были').toBeGreaterThanOrEqual(3);
    expect([...new Set(seen)]).toEqual([`${SOURCE_LANG}|Слишком часто|-`]);
  });
});
