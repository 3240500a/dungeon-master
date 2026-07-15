# Спрайты персонажей (PNG)

Клади сюда PNG игроков. Имя файла = ключ спрайта класса (поле `sprite` в `classes.json`):

| Класс | Файл |
|---|---|
| Волкодав | `player-volkodav.png` |
| Заклинатель | `player-mage.png` |
| Ловчая | `player-archer.png` |
| Заступник | `player-warrior.png` |
| Вьюга | `player-vyuga.png` |
| Вольный стрелок | `player-arbalest.png` |
| Ворожея | `player-vorozheya.png` |

- Любой размер — движок нормирует к ~40px в игре и ~76px в выборе класса (по большей стороне).
- Прозрачный фон (top-down вид). Квадрат удобнее, но не обязателен.
- Нет файла → рисуется кружок-фолбэк (цвет из `core/textures.ts` `PLAYER_SPRITE_COLORS`).
- После добавления/замены PNG: перезапуск `npm run dev` не нужен (Vite public), но **Ctrl+F5** в игре (кэш).
