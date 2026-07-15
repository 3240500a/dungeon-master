import Phaser from 'phaser';
// Заголовочные шрифты (локальный бандл): латиница — Cinzel, кириллица — Forum.
// @font-face регистрируются импортом CSS; фактическая загрузка ждётся в BootScene.
import '@fontsource/cinzel/400.css';
import '@fontsource/forum/400.css';
import { App } from './core/app.js';
import { BootScene } from './scenes/BootScene.js';
import { PreloadScene } from './scenes/PreloadScene.js';
import { MainMenuScene } from './scenes/MainMenuScene.js';
import { LoginScene } from './scenes/LoginScene.js';
import { CharacterSelectScene } from './scenes/CharacterSelectScene.js';
import { ClassSelectScene } from './scenes/ClassSelectScene.js';
import { OnlineScene } from './scenes/OnlineScene.js';
import { UIScene } from './scenes/UIScene.js';
import { DomUi } from './ui/domUi.js';
import { inventoryPanel } from './modules/inventory/inventoryPanel.js';
import { characterPanel, masterPanel } from './modules/progression/panels.js';
import { skillsPanel } from './modules/skills/skillsPanel.js';
import { shopPanel } from './modules/town/shopPanel.js';
import { forgePanel } from './modules/town/forgePanel.js';
import { difficultyPanel } from './modules/town/difficultyPanel.js';
import { stashPanel } from './modules/town/stashPanel.js';
import { questLogPanel } from './modules/quests/questLogPanel.js';
import { SfxController } from './modules/sfx/sfx.js';
import { GameLog } from './ui/gameLog.js';

const app = new App();

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0b0b10',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },
  physics: {
    default: 'arcade',
    arcade: { debug: false },
  },
  scene: [
    BootScene,
    PreloadScene,
    MainMenuScene,
    LoginScene,
    CharacterSelectScene,
    ClassSelectScene,
    OnlineScene,
    UIScene,
  ],
};

const game = new Phaser.Game(config);
// Глобальные сервисы доступны сценам через App.from(scene).
game.registry.set('app', app);

// DOM-оверлей UI (модальные панели поверх canvas).
const uiRoot = document.getElementById('ui-root')!;
const domUi = new DomUi(app, uiRoot);
domUi.register('inventory', inventoryPanel);
domUi.register('character', characterPanel);
domUi.register('master', masterPanel);
domUi.register('skills', skillsPanel);
domUi.register('shop', shopPanel);
domUi.register('forge', forgePanel);
domUi.register('quests', questLogPanel);
domUi.register('difficulty', difficultyPanel);
domUi.register('stash', stashPanel);

// Глобальные контроллеры уровня приложения (живут между сценами). Онлайн-игра:
// прогрессия/лут/сейв — авторитетно на сервере (клиентских наград/синка нет).
new SfxController(app);
app.gameLog = new GameLog(app, uiRoot); // скрыт по умолчанию; OnlineScene показывает его в игре

// Dev-only: доступ к игре/сервисам из консоли и e2e-проверок.
if (import.meta.env.DEV) {
  (window as unknown as { dm: unknown }).dm = { game, app, domUi };
}
