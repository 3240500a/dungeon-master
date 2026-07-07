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

`node:sqlite` требует **Node 24** (см. `.nvmrc`).

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
# Node.js 24 (для node:sqlite)
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
Environment=DM_DB=/opt/dm/data/dm.db
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
- **Бэкап БД:** единственный ценный файл — `DM_DB` (`/opt/dm/data/dm.db`). Включи бэкап диска TimeWeb
  или cron `cp`.
- **Баланс в проде фиксирован:** `NODE_ENV=production` отключает live-правку конфига из редактора
  (анти-чит). Меняй баланс локально → Экспорт JSON в `data/*.json` → коммит → обновление (см. выше).
- **Одна инстанция:** комнаты живут в памяти; рестарт роняет активные забеги, но автосейв (10с) +
  грейс-реконнект сохраняют прогресс. Горизонтально не масштабируется.

## Локальная проверка прод-режима (перед деплоем)
```bash
npm run build
NODE_ENV=production PORT=3001 npm start
# открой http://localhost:3001 — грузится игра, регистрация/вход/забег на одном origin
```
