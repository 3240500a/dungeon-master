import { attrRespecRefund } from '@dm/shared';
import type { App } from '../../core/app.js';
import { button } from '../../ui/kit.js';

/** Сброс ждёт ответа сервера — по приложению: окно перерисовывается и собирает кнопку заново. */
const inFlight = new WeakSet<object>();

/**
 * ⭐ R6-11: «Сбросить атрибуты (N золота)» мастера прокачки. Гаснет, когда сбрасывать нечего (атрибуты — стартовые класса,
 * `attrRespecRefund` — то же число, по которому отказывает ядро) или не хватает золота; спрашивает подтверждение, как сбросы
 * скилов и мастерств; пока команда в полёте — погашена. Окно перерисовывается только по `saveUpdate`, и двойной клик раньше
 * уходил двумя командами: второй платил 500 за ничто.
 */
export function respecAttrsButton(app: App): HTMLButtonElement {
  const cost = app.config.get('balance').respecCost;
  const save = app.state!.save;
  const refund = attrRespecRefund(app.config, save);
  const blocked = (): boolean => inFlight.has(app) || refund === 0 || save.gold < cost;
  const b = button(`Сбросить атрибуты (${cost} золота)`, () => {
    if (blocked()) return;
    if (!window.confirm(`Сбросить атрибуты?\nВернётся ${refund} очк. атрибутов, цена ${cost} зол.`)) return;
    inFlight.add(app);
    b.disabled = true;
    b.style.opacity = '0.5';
    // R5-15: дороже показанного сервер не возьмёт. Отказ — строкой в лог: ждущему окну `App` его сам не пишет.
    void app.request({ cmd: 'respec', maxGold: cost }).then((r) => {
      inFlight.delete(app);
      if (r && !r.ok && r.reason) app.bus.emit('log:message', { text: `Не вышло: ${r.reason}`, kind: 'system' });
      app.bus.emit('state:changed', {});
    });
  }, 'default', blocked());
  if (refund === 0) b.title = 'Атрибуты не вложены — сбрасывать нечего';
  return b;
}
