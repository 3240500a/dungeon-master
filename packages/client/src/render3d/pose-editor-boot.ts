/** Boot редактора: СНАЧАЛА тянем с сервера конфиг (классы/монстры) + контент поз-редактора в localStorage,
 *  ПОТОМ грузим редактор (он на старте читает localStorage — ростер/клипы/гейты). Единая истина = сервер.
 *  Тело в async-IIFE (не top-level await): иначе прод-таргет es2020 не собирает. */
import { syncPoseFromServer, syncConfigFromServer } from './poseServer.js';

void (async (): Promise<void> => {
  await Promise.all([syncConfigFromServer(), syncPoseFromServer()]);
  await import('./pose-editor.js');
})();
