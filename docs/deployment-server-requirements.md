# Требования к VM для размещения приложения «Фото-отчёт АЗС»

Документ предназначен для ИТ-отдела клиента.  
Цель: подготовить виртуальную машину для размещения production-версии приложения `Фото-отчёт АЗС`.

Приложение является внешним приложением Bitrix24 и должно быть доступно порталу Bitrix24 по публичному HTTPS-адресу.

## 1. Что будет размещено на VM

На VM размещаются:
- frontend приложения;
- Node.js backend API;
- PostgreSQL;
- reverse proxy с HTTPS;
- Docker containers и Docker volumes;
- служебные логи приложения.

Автоматический деплой через GitHub не требуется. Обновления выполняются вручную в согласованное окно работ.

## 2. Характеристики VM

Минимальные требования:

| Параметр | Требование |
|---|---|
| CPU | 2 vCPU |
| RAM | 4 GB |
| Disk | 20 GB SSD |
| OS | Ubuntu Server 22.04 LTS или 24.04 LTS |
| Architecture | x86_64 |

Дополнительно:
- место под backup должно быть вне основной VM;
- диск VM должен мониториться, так как фото хранятся в Bitrix24 Диске, но база, Docker images, volumes и логи остаются на сервере приложения.

## 3. DNS и сеть

Требуется выделенный домен или поддомен, например:

```text
azs-app.company.ru
```

Требования:
- домен должен быть направлен на VM;
- приложение должно открываться по HTTPS;
- входящий порт `443` должен быть открыт;
- входящий порт `80` допускается только для выпуска и обновления TLS-сертификата;
- SSH-порт `22` должен быть доступен только с IP-адресов администраторов или через VPN;
- VM должна иметь исходящий HTTPS-доступ на порт `443` до Bitrix24 и Docker registry.

Запрещено:
- открывать PostgreSQL наружу;
- открывать backend API отдельным публичным портом;
- использовать Cloudpub, ngrok или аналогичные временные туннели в production.

## 4. Требования безопасности

Обязательно:
- SSH только по ключам;
- вход по паролю отключён;
- root login по SSH отключён;
- firewall включён;
- разрешены только необходимые входящие порты: `22`, `80`, `443`;
- для эксплуатации создан отдельный технический пользователь, например `azsdeploy`;
- секреты хранятся только на сервере или в корпоративном секрет-хранилище.

Нельзя передавать в Git:
- OAuth client secret;
- JWT secret;
- job secret;
- OAuth access/refresh tokens;
- пароли базы данных;
- любые bearer tokens.

## 5. Необходимое ПО

На VM нужно установить:
- `git`;
- `docker`;
- `docker compose`;
- `nginx` или `caddy`;
- `certbot`, если используется nginx;
- `curl`;
- `ufw` или другой firewall;
- агент мониторинга, если он принят в инфраструктуре клиента.

Проверка:

```bash
docker --version
docker compose version
git --version
curl --version
```

## 6. Рекомендуемая структура каталогов

```text
/opt/azs-prod/app          # код приложения
/opt/azs-prod/env          # production env, доступ ограничен
/opt/azs-prod/backups      # временные локальные backup-копии
/opt/azs-prod/logs         # дополнительные логи, если нужны вне Docker
```

Требования к правам:
- владелец каталогов — технический пользователь приложения;
- файл `.env` доступен только техническому пользователю и администраторам;
- backup-каталог не должен быть доступен публично.

## 7. Reverse proxy и HTTPS

Публичный адрес приложения:

```text
https://azs-app.company.ru
```

Reverse proxy должен проксировать запросы к frontend-контейнеру приложения.

Требования:
- TLS 1.2 или выше;
- автоматическое обновление TLS-сертификата;
- redirect с HTTP на HTTPS;
- лимит upload не меньше 25 MB;
- proxy timeout не меньше 60 секунд.

## 8. Production env

ИТ-отдел должен подготовить защищённое место для production `.env`. Значения переменных передаются ответственным за приложение отдельно.

В `.env` должны быть настроены группы параметров:
- Bitrix24 OAuth;
- публичный адрес приложения;
- JWT и job secrets;
- параметры бота Bitrix24;
- параметры PostgreSQL;
- runtime-параметры production-режима.

После изменения домена, OAuth credentials, scopes или параметров бота приложение нужно переустановить в Bitrix24.

## 9. Запуск приложения

Запуск выполняется из каталога приложения:

```bash
COMPOSE_PROFILES=frontend,node,db-postgres docker compose --env-file .env up -d --build
```

Проверка:

```bash
docker ps
curl -fsS https://azs-app.company.ru/api/health
```

## 10. Обновления приложения

Обновления выполняются вручную в согласованное окно работ.

Порядок обновления:
1. Сделать backup PostgreSQL и `.env`.
2. Получить согласованный release commit или release tag.
3. При необходимости включить maintenance-режим на reverse proxy.
4. Обновить код приложения.
5. Пересобрать и поднять контейнеры.
6. Проверить `/api/health`.
7. Открыть приложение в Bitrix24 администратором.
8. Проверить создание тестового отчёта и отправку уведомления бота.

Пример команд:

```bash
cd /opt/azs-prod/app
git fetch origin
git checkout <release_tag_or_commit>
COMPOSE_PROFILES=frontend,node,db-postgres docker compose --env-file .env up -d --build
curl -fsS https://azs-app.company.ru/api/health
```

## 11. Backup

Обязательно настроить:
- ежедневный backup PostgreSQL;
- backup перед каждым обновлением;
- backup `.env` в защищённое хранилище;
- хранение минимум 7 последних ежедневных копий;
- периодическую проверку восстановления backup.

Backup должен храниться вне основной VM.

## 12. Мониторинг

Нужно контролировать:
- доступность `https://azs-app.company.ru/api/health`;
- свободное место на диске;
- состояние Docker containers;
- потребление CPU/RAM;
- ошибки reverse proxy;
- ошибки backend;
- срок действия TLS-сертификата;
- успешность backup.

## 13. Rollback

Rollback выполняется вручную.

Порядок:
1. Зафиксировать ошибку и время инцидента.
2. Вернуться на предыдущий release commit или release tag.
3. Пересобрать и поднять контейнеры.
4. Если менялись данные или схема БД, восстановить backup.
5. Проверить `/api/health`.
6. Проверить открытие приложения из Bitrix24.

Пример команд:

```bash
cd /opt/azs-prod/app
git checkout <previous_release_tag_or_commit>
COMPOSE_PROFILES=frontend,node,db-postgres docker compose --env-file .env up -d --build
curl -fsS https://azs-app.company.ru/api/health
```

## 14. Критерии готовности VM

VM считается готовой, если:
- выделен домен или поддомен;
- домен направлен на VM;
- HTTPS работает;
- SSH доступен только по ключу;
- вход по SSH-паролю отключён;
- root login по SSH отключён;
- firewall настроен;
- Docker и Docker Compose установлены;
- каталог `/opt/azs-prod` создан;
- production `.env` размещён безопасно;
- PostgreSQL не доступен извне;
- reverse proxy принимает upload до 25 MB;
- backup настроен;
- мониторинг настроен;
- `https://azs-app.company.ru/api/health` возвращает успешный ответ после запуска приложения.
