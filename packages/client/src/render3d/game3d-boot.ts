/** Boot 3D-клиента (ОНЛАЙН): синк серверного конфига (классы/монстры) + контента поз-редактора в localStorage,
 *  затем запуск полностью онлайнового клиента (`online3d`): авторизация → выбор персонажа → мир из снапшотов.
 *  Никаких локальных сессий — единая истина сервер, как в 2D-клиенте.
 *  Тело в async-IIFE (не top-level await): иначе прод-таргет es2020 не собирает. */
import { syncPoseFromServer, syncConfigFromServer } from './poseServer.js';

void (async (): Promise<void> => {
  await Promise.all([syncConfigFromServer(), syncPoseFromServer()]);
  const { startOnline3d } = await import('./online3d.js');
  await startOnline3d();
})();
