# 08. Эксплуатация

## Локальный Запуск

```bash
make dev-node
```

После запуска проверить:

```text
/api/health
```

Приложение нужно тестировать из Bitrix24 iframe, потому что auth зависит от OAuth-данных портала.

## Основные ENV

Без значений секретов:

- `APP_BASE_URL`: backend/frontend base URL внутри приложения.
- `APP_PUBLIC_BASE_URL`: публичный HTTPS URL, например Cloudpub.
- `JWT_SECRET`: секрет подписи JWT.
- `JOB_SECRET`: секрет для защищённых job endpoints.
- `SCHEDULER_ENABLED`: включает scheduler.
- `DEFAULT_TIMEZONE`: обычно `Europe/Moscow`.
- `DB_TYPE`: тип БД.
- `POSTGRES_*`: настройки PostgreSQL.
- `CLIENT_ID`: OAuth client id приложения.
- `CLIENT_SECRET`: OAuth client secret.
- `SCOPE`: scopes приложения.
- `BITRIX_BOT_MODE`: `bot` или `notify`.
- `BITRIX_BOT_ID`: ID зарегистрированного бота.
- `BITRIX_BOT_CODE`: код бота.
- `BITRIX_BOT_NAME`: имя бота.
- `BITRIX_APP_CODE`: код приложения для app-link/placement.
- `CLOUDPUB_TOKEN`: токен Cloudpub.

Секреты не коммитятся и не переносятся в Markdown.

## Переустановка Приложения

Переустановка нужна после:
- изменения scopes;
- изменения bot registration;
- изменения placement/link binding;
- смены OAuth client credentials.

После переустановки открыть приложение администратором портала, чтобы backend получил свежий admin OAuth-контекст.

## Scheduler

Scheduler работает только если:
- включён флаг scheduler;
- есть сохранённые времена `dispatchTimes`;
- есть активные АЗС;
- у backend есть валидный admin Bitrix24 OAuth-контекст;
- корректно настроены поля `АЗС`, `Типы фото`, `Отчёты АЗС`.

Если контекста нет, scheduler не должен падать. Он пишет диагностируемую ошибку и пропускает тик.

## Token Refresh

OAuth-контексты хранятся per-user. При истечении access token backend должен обновить его через refresh token и сохранить обновлённый контекст той же записи.

Типовые признаки проблемы:
- `expired_token`;
- `context_not_found`;
- `auth_context_unavailable`;
- `app.info failed`;
- `profile failed`.

Первое действие: открыть приложение администратором портала и проверить `/api/health`.

## Типовые Ошибки

`disk.folderNameTemplate must be a non-empty string`  
Причина: пустой шаблон папки. Заполнить `disk.folderNameTemplate`, например `{yyyy-mm}/{dd}/{azs}`.

`Current user is not report administrator`  
Причина: текущий пользователь не совпадает с ответственным отчёта. Проверить поле `Администратор АЗС` и роль пользователя.

`reportItemId is missing or invalid`  
Причина: отчёт не связан с реальной карточкой СП `Отчёты АЗС`. Нужна диагностика создания отчёта.

`expired_token`  
Причина: устарел Bitrix24 access token. Backend должен выполнить refresh; если не получилось, открыть приложение администратором.

`insufficient_scope`  
Причина: приложению не хватает прав. Добавить scope и переустановить приложение.

## Логи

Рабочие логи проекта ведутся в:

```text
docs/logs/
```

Технические runtime-логи смотреть в логах backend/frontend контейнеров.
