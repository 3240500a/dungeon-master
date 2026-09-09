# DEPLOY.md — деплой на TimeWeb (Облачный сервер / VDS)

Игра = **один Node-процесс**, который отдаёт статику клиента (`packages/client/dist`) + REST `/api/*`
+ WebSocket `/ws` на **одном домене**. Клиент сам находит сервер на том же origin (`/api`,
`wss://<host>/ws`) — доп. настройка клиента не нужна.

## Какой сервер брать
**«Облачный сервер» (VDS/VPS, KVM)** — НЕ «Облачное приложение» (App Platform: эфемерная ФС, БД
сотрётся при редеплое) и НЕ «Виртуальный хостинг» (shared). Спека для плейтеста:
- Ubuntu **24.04 LTS**
- **2 vCPU / 2 ГБ RAM** (2 ГБ — чтобы сборка клиента не упёрлась в память; при 1 ГБ собирай
  `client/dist` локально и заливай)
- 15–30 ГБ NVMe, публичный IPv4

Нужны **Node 24** (см. `.nvmrc`) и **PostgreSQL 16+**.

## Cloud-init (необязательно, но удобно на первый раз)
Поле «Cloud-init» при создании сервера = скрипт, который выполнится ОДИН РАЗ при первом запуске
(от root). Вставь туда этот скрипт — он поставит базу (swap, Node 24, git, Caddy, фаервол), и шаг 1
ниже делать не нужно (сразу переходи к доставке кода):
```bash
#!/bin/bash
set -eux
# swap 2 ГБ — чтобы сборка клиента не упала по памяти на 2 ГБ RAM
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
apt-get update && apt-get install -y curl git ufw
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
# Caddy (авто-HTTPS reverse-proxy)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
# фаервол: SSH, HTTP, HTTPS + временный прямой порт 3001 (тест без домена)
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw allow 3001 && ufw --force enable
```
Проверить после загрузки: `cloud-init status --wait` (должно быть `done`), `cat /var/log/cloud-init-output.log` при ошибках.

## Шаги (SSH на сервер под root)

```bash
# 1) Node 24 + git + Caddy
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
node -v   # должно быть v24.x

# 2) Код + сборка клиента
# Проект пока не в git-remote — сначала запушь его на GitHub/GitLab (`git init && git remote add ...
# && git push`) ЛИБО залей папку без node_modules: rsync -a --exclude node_modules ./ root@IP:/opt/dm
git clone <URL-репозитория> /opt/dm
cd /opt/dm
npm ci
npm run build        # собирает shared + client/dist
mkdir -p /opt/dm/data
```

### 3) systemd-сервис `/etc/systemd/system/dm.service`
```ini
[Unit]
Description=Dungeon Master server
After=network.target

[Service]
WorkingDirectory=/opt/dm
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=DM_PG=postgresql://dm:ПАРОЛЬ@127.0.0.1:5432/dungeon
Environment=DM_BEHIND_TLS=1
# Ф4: КЛАСТЕР. Супервизор поднимает гейтвей на PORT и игровые ноды на PORT+1…
# Без DM_ROLE сервер работает в одиночном режиме — один процесс, одно ядро.
Environment=DM_ROLE=supervisor
# Сколько игровых нод. По умолчанию «ядра минус два» (гейтвею и базе тоже надо жить).
# Environment=DM_NODES=8
# Потолок кластера: сверх него игроки встают в очередь, а не роняют сервер.
# Environment=DM_MAX_PLAYERS=3000
ExecStart=/usr/bin/npx tsx packages/server/src/index.ts
Restart=always
RestartSec=2
# graceful-flush прогресса при рестарте (в коде есть SIGTERM-хук)
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload && systemctl enable --now dm
systemctl status dm         # активен?
curl -s localhost:3001/api/health   # {"ok":true,...}
```

### 3a) Кластер: что видно снаружи (Ф4)

Клиент сначала спрашивает у гейтвея адрес игрового узла (`GET /api/route`), а дальше говорит
с узлом НАПРЯМУЮ. Гейтвей игру не проксирует специально: проксируй он кадры, вся работа,
разложенная по процессам, снова сошлась бы в одном.

Значит наружу должны быть видны и гейтвей, и узлы. Два способа:

**А. По путям за обратным прокси (рекомендуется — один порт, один сертификат).**
Узлы отдают адрес вида `wss://ваш-домен/ws/<i>`, прокси разносит их по портам:

```
Environment=DM_NODE_URL_TEMPLATE=wss://ваш-домен/ws/{i}
```

и в Caddy:

```
ваш-домен {
    reverse_proxy /ws/0 127.0.0.1:3002
    reverse_proxy /ws/1 127.0.0.1:3003
    # … по одной строке на узел
    reverse_proxy 127.0.0.1:3001        # всё остальное — гейтвею
}
```

**Б. По портам (проще, но нужен отдельный сертификат или открытые порты).**
Оставить умолчание `ws://<хост>:<порт>/ws` и открыть порты узлов в брандмауэре.

Проверить раскладку: `curl -s localhost:3001/api/cluster` — видно все узлы, сколько на каждом
игроков и комнат. Метрики на гейтвее (`/metrics`) — СУММА по кластеру, имена те же, что были
у одиночного процесса, так что дашборд менять не надо.

### 3b) Обновление без потери забегов

`systemctl restart dm` шлёт SIGTERM супервизору, тот — узлам. Узел помечается «сливаемым»
(гейтвей перестаёт слать к нему новых), дописывает прогресс всех комнат и выходит.
Поэтому `TimeoutStopSec` должен быть БОЛЬШЕ, чем время записи: 30 секунд с запасом.

Игроки, чей узел ушёл на перезапуск, возвращаются механизмом грейс-реконнекта: закрепление
персонажа за узлом живёт пять минут, и клиент попадёт в свою комнату, когда узел поднимется.

### 4) Домен + HTTPS (Caddy) — `/etc/caddy/Caddyfile`
Направь A-запись домена (или суб-домена) на IP сервера, затем:
```
game.твойдомен.ру {
    reverse_proxy localhost:3001
}
```
```bash
systemctl reload caddy   # Caddy сам возьмёт Let's Encrypt-серт и проксирует WebSocket
```
Открой в браузере `https://game.твойдомен.ру` — с любого компа.

**Быстро без домена (первый тест):** открой порт 3001 в фаерволе TimeWeb и играй по
`http://<IP-сервера>:3001` (WebSocket на http-странице работает; HTTPS нет).

## Обновление версии
```bash
cd /opt/dm && git pull && npm ci && npm run build && systemctl restart dm
```

## Важное
- **Бэкап БД:** `pg_dump dungeon | gzip > /var/backups/dm-$(date +%F).sql.gz` по cron. Бэкап диска
  TimeWeb этого НЕ заменяет: копия файлов работающей базы может оказаться нецелостной.
- **Postgres обязателен.** Сервер не поднимется без `DM_PG` в проде (осознанно: молчаливый уход на
  localhost хуже падения при старте). Схема создаётся сама при первом запуске.
- **Перенос авторского контента** со старой SQLite (позы редактора и оверрайды конфига) — разово:
  `npm run db:import -- --from=packages/server/data/dm.db`. Аккаунты и персонажи НЕ переносятся.
- **Баланс в проде фиксирован:** `NODE_ENV=production` отключает live-правку конфига из редактора
  (анти-чит). Меняй баланс локально → Экспорт JSON в `data/*.json` → коммит → обновление (см. выше).
- **Доступ к инструментальным роутам — ПО РОЛИ, а не по адресу.** Раньше `/api/dev/*` гейтились
  «запрос с локальной машины». Это не пропуск, а его видимость: браузер разработчика тоже ходит
  с 127.0.0.1, то есть под гейт подпадала любая открытая в нём страница. Теперь пускает роль
  `users.role='admin'` (выдаёт `npm run grant-admin -- <ник>`, снимает `revoke-admin`, список — `npm run admins`)
  либо `DM_ADMIN_KEY` — длинный случайный секрет для ПРОЦЕССОВ (скрипты, шим генерации анимаций).
  Отзыв: роль читается на КАЖДОМ запросе, поэтому `revoke-admin` действует сразу; ключ гасится сменой
  переменной. В проде эти роуты всё равно выключены `NODE_ENV=production` — два независимых условия остались.
- **`DM_ORIGINS` — белый список источников CORS** (через запятую; умолчание — два дев-сервера
  `http://localhost:5173,http://localhost:5174`). Раньше стоял `cors()` без параметров — API отвечал любому
  источнику. СОБСТВЕННЫЙ хост разрешён всегда, поэтому раздача клиента с того же адреса
  (`DM_SERVE_STATIC`) не требует настройки; пустая переменная трактуется как незаданная (описка не должна
  молча отрезать редакторы). Запросы без `Origin` (curl, сервер-сервер) не отсекаются: CORS защищает
  браузер от чужой страницы, а сервер защищает авторизация.
- **`GET /api/pose` и `/api/config` ОСТАЮТСЯ публичными** — это контент, который клиент тянет
  ДО входа (`render3d/game3d-boot.ts` зовёт их до экрана авторизации). Закрыть их токеном значит
  сломать запуск игры; закрыта ЗАПИСЬ (`POST/DELETE /api/dev/pose`), а она и есть опасная часть.
- **Масштабирование (Ф4):** комнаты живут в памяти узла и за ним закреплены на всё время жизни.
  Горизонтально масштабируется процессами на одной машине (`DM_ROLE=supervisor`); на несколько
  машин — тем же реестром в общей базе, узлам достаточно видеть один Postgres.
- **Канал важнее процессора.** При 10–12 КБ/с на игрока гигабитный канал упирается примерно
  на 7 000 игроков — раньше, чем процессор на большинстве серверов. Раздачу клиента (бандл
  и модели) держите на CDN, иначе холодные заходы съедят тот же канал.

## Локальная проверка прод-режима (перед деплоем)
```bash
npm run build
NODE_ENV=production PORT=3001 npm start
# открой http://localhost:3001 — грузится игра, регистрация/вход/забег на одном origin
```
