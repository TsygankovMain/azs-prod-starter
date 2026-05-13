# Документация MVP «Фото-отчёт АЗС»

Этот раздел фиксирует актуальное состояние MVP, чтобы продукт, клиент, Bitrix24-специалист и разработчик не восстанавливали контекст из переписки.

## Что Читать

Для клиента и продукта:
- [Описание продукта](client-product-description.md)
- [Краткое ТЗ к договору](contract-technical-assignment.md)
- [Сценарии пользователей](spec-kit/02-user-journeys.md)
- [Приёмка MVP](spec-kit/07-testing-and-acceptance.md)

Для специалиста Bitrix24:
- [Настройка портала Bitrix24](spec-kit/03-bitrix24-setup.md)
- [Роли и доступ](spec-kit/01-roles-and-access.md)
- [Данные и настройки](spec-kit/06-data-and-settings.md)

Для разработчика и агента:
- [Обзор MVP](spec-kit/00-overview.md)
- [Архитектура](spec-kit/04-architecture.md)
- [API-контракты](spec-kit/05-api-contracts.md)
- [Эксплуатация](spec-kit/08-operations.md)
- [Требования к VM для размещения](deployment-server-requirements.md)
- [Деплой в Timeweb App Platform](timeweb-app-platform-deploy.md)

Для истории работ:
- Рабочие логи находятся в `docs/logs/`.
- Spec-kit не заменяет логи и не хранит историю всех решений.

## Правило Безопасности

В документации нельзя хранить:
- bearer/access/refresh tokens;
- Cloudpub token;
- `CLIENT_SECRET`;
- реальные OAuth-контексты пользователей;
- приватные webhook URL.

Все секреты хранятся только в локальном `.env`, Keychain или защищённом секрет-хранилище окружения.
