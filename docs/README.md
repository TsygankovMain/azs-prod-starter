# Документация «Фото-отчёт АЗС»

Единый индекс документации. Все документы на русском языке.

---

## Для клиента и продукт-менеджера

- [Описание продукта](client-product-description.md) — что делает приложение, роли, основной сценарий, ограничения MVP.
- [Краткое ТЗ к договору](contract-technical-assignment.md) — scope, функциональность, требования к хостингу, критерии приёмки.
- [Пользовательские релизы](RELEASES.md) — что нового в каждой версии, человеческим языком.

---

## Для специалиста Bitrix24

- [Настройка портала Bitrix24](spec-kit/03-bitrix24-setup.md) — смарт-процессы, поля, стадии, бот, scopes, маппинг в настройках приложения.
- [Роли и доступ](spec-kit/01-roles-and-access.md)
- [Данные и настройки](spec-kit/06-data-and-settings.md)
- [Сценарии пользователей](spec-kit/02-user-journeys.md)

---

## Для разработчика и агента

### Архитектура
- [Обзор архитектуры](architecture/overview.md) — стек, компоненты, БД, OAuth/JWT, синхронизация с Bitrix24, деплой.
- [Карта фич → файлы](architecture/feature-map.md) — таблица «фича → frontend → backend → заметки» с реальными путями.

### Spec-kit (детальные спецификации)
- [00 — Обзор MVP](spec-kit/00-overview.md)
- [01 — Роли и доступ](spec-kit/01-roles-and-access.md)
- [02 — Сценарии пользователей](spec-kit/02-user-journeys.md)
- [03 — Настройка Bitrix24](spec-kit/03-bitrix24-setup.md)
- [04 — Архитектура](spec-kit/04-architecture.md)
- [05 — API-контракты](spec-kit/05-api-contracts.md)
- [06 — Данные и настройки](spec-kit/06-data-and-settings.md)
- [07 — Тестирование и приёмка](spec-kit/07-testing-and-acceptance.md)
- [08 — Эксплуатация](spec-kit/08-operations.md)
- [FAQ и проектирование пагинации АЗС](spec-kit/2026-05-25-faq-and-azs-pagination-design.md)

### Технические логи
- [CHANGELOG](CHANGELOG.md) — технический лог изменений по спринтам.
- [Code Review Log](code-review-log.md) — аудиты кода, находки, решения.

### Операционная документация
- [Требования к VM](deployment-server-requirements.md) — для IT-отдела клиента.
- [Деплой в Timeweb App Platform](timeweb-app-platform-deploy.md) — single-container Docker.

---

## Superpowers (спеки и планы агентов)

- [Дизайн v2.0](superpowers/specs/2026-05-31-azs-v2-design.md)
- [Sprint 1 v2.0 — план](superpowers/plans/2026-05-31-azs-v2-sprint1-durable-crm-sync.md)

---

## История работ

- [Рабочий журнал проекта](logs/project-log.md) — хронологический лог ключевых решений.
- Архив спринт-логов и мокапов → [`docs/logs/archive/`](logs/archive/)

---

## Правило Безопасности

В документации нельзя хранить:
- bearer/access/refresh tokens;
- Cloudpub token;
- `CLIENT_SECRET`;
- реальные OAuth-контексты пользователей;
- приватные webhook URL.

Все секреты хранятся только в локальном `.env`, Keychain или защищённом секрет-хранилище окружения.
