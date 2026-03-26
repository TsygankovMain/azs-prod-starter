# Телеметрия: быстрый старт для UI-приложений

> Руководство для разработчиков приложений типа 1 (UI-Centric).  
> Приложение b24-ai-starter-ru является **UI-Centric (тип 1)**: основная логика выполняется на  
> фронтенде, бэкенд выполняет отдельные синхронные команды по запросу фронта.

---

## Содержание

1. [Быстрый старт](#1-быстрый-старт)
2. [Переменные окружения](#2-переменные-окружения)
3. [Включение и выключение телеметрии](#3-включение-и-выключение-телеметрии)
4. [Профиль simple-ui](#4-профиль-simple-ui)
5. [Lifecycle события](#5-lifecycle-события)
6. [UI события](#6-ui-события)
7. [Action и API события](#7-action-и-api-события)
8. [Замер длительности операций (trackOperation)](#8-замер-длительности-операций-trackoperation)
9. [Инъекция сервиса телеметрии](#9-инъекция-сервиса-телеметрии)
10. [Фронтенд-события (Nuxt → PHP)](#10-фронтенд-события-nuxt--php)

---

## 1. Быстрый старт

### Минимальная конфигурация

Для запуска в Docker отредактируйте корневой `.env`:

```dotenv
TELEMETRY_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_SERVICE_NAME=b24-app
OTEL_SERVICE_VERSION=1.0.0
OTEL_TELEMETRY_PROFILE=simple-ui
```

Для запуска PHP вне Docker добавьте аналогичные переменные в `backends/php/.env.local` (endpoint: `http://localhost:4318`).

Запустите b24-ai-starter-otel (сборщик и хранилище):

```bash
cd ../b24-ai-starter-otel && make up
```

Готово. При следующем запросе к приложению события начнут отправляться автоматически.

### Проверка работы

```bash
# Проверить коннект к коллектору
curl -v http://localhost:4318/v1/traces

# Запустить unit-тесты телеметрии
make test-telemetry
```

---

## 2. Переменные окружения

| Переменная                        | По умолчанию              | Описание                                                |
|-----------------------------------|---------------------------|---------------------------------------------------------|
| `TELEMETRY_ENABLED`               | `false`                   | Включить телеметрию (`true` / `false`)                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | `http://localhost:4318`   | URL OpenTelemetry Collector                             |
| `OTEL_SERVICE_NAME`               | `b24-app`                 | Имя сервиса в `otel_logs` и `otel_traces`               |
| `OTEL_SERVICE_VERSION`            | `1.0.0`                   | Версия сервиса                                          |
| `OTEL_ENVIRONMENT`                | `development`             | Окружение (попадает в `deployment.environment` span-атрибут)    |
| `OTEL_TELEMETRY_PROFILE`          | `simple-ui`               | Активный профиль фильтрации атрибутов                     |

### Конфигурация по окружениям

Основной файл конфигурации при запуске через Docker — корневой `.env`.
Для локального PHP без Docker используйте `backends/php/.env.local` (переменные среды Symfony перекрывают `.env`).

**Production** (`корневой .env`):
```dotenv
TELEMETRY_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_SERVICE_NAME=b24-app
OTEL_SERVICE_VERSION=1.0.0
OTEL_ENVIRONMENT=production
OTEL_TELEMETRY_PROFILE=simple-ui
```

**Development** (`backends/php/.env.local` для локального PHP):
```dotenv
TELEMETRY_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=b24-app
OTEL_SERVICE_VERSION=dev
OTEL_ENVIRONMENT=development
OTEL_TELEMETRY_PROFILE=simple-ui
```

**Testing**: `TELEMETRY_ENABLED=false` задан по умолчанию в корневом `.env`. Дополнительная настройка `backends/php/.env.test` не требуется.

---

## 3. Включение и выключение телеметрии

### Глобальное переключение

Установите `TELEMETRY_ENABLED=false` — все вызовы `trackEvent()` и `trackError()` станут no-op через `NullTelemetryService` с **нулевым overhead**:

```dotenv
TELEMETRY_ENABLED=false
```

Контроллеры и сервисы при этом **не требуют изменений** — интерфейс `TelemetryInterface` одинаков для обеих реализаций.

### Проверка статуса в коде

```php
if ($this->telemetry->isEnabled()) {
    // Подготовить тяжёлые атрибуты только если телеметрия включена
    $heavyAttributes = $this->buildDiagnosticsPayload();
    $this->telemetry->trackEvent('debug_snapshot', $heavyAttributes);
}
```

### Как работает Null Object паттерн

```
TELEMETRY_ENABLED=true  → TelemetryFactory → RealTelemetryService  (OTLP отправка)
TELEMETRY_ENABLED=false → TelemetryFactory → NullTelemetryService   (ничего не делает)
```

`TelemetryFactory` создаёт нужную реализацию при старте контейнера. После создания объекта проверок нет — переключение происходит только перед деплоем через переменную окружения.

---

## 4. Профиль simple-ui

Профиль `simple-ui` — профиль по умолчанию для b24-ai-starter-ru.

**Включает атрибуты из двух групп:**

| Группа             | Атрибуты                                                              |
|--------------------|-----------------------------------------------------------------------|
| `LifecycleProfile` | `app.*`, `portal.*`, `lifecycle.*`, `registration.*`, `event_handler.*`, `b24.*`, `placement.*`, `automation.*`, `telemetry.channel` |
| `UIProfile`        | `ui.*`, `screen.*`, `session.*`, `action.*`, `api.*`, `error.*`, `event.source`, `interaction.*`, `button.*`, `form.*`, `widget.*`, `user.*`, `external.*`, `b24.method`, `b24.command` |

**Итого**: ~72 атрибута. Достаточно для UI-приложений без сложной бизнес-логики.

### Активация через переменную окружения

Активный профиль задаётся в корневом `.env` (Docker) или `backends/php/.env.local` (локально):

```dotenv
# Допустимые значения: simple-ui | integration-sync | integration-with-migration | migrator-light | migrator-advanced | development
OTEL_TELEMETRY_PROFILE=simple-ui
```

Изменить профиль можно без перезапуска приложения — достаточно перезапустить PHP-контейнер.

### Когда использовать другой профиль

| Ситуация                                   | Профиль                 |
|--------------------------------------------|-------------------------|
| Только UI виджет                           | `simple-ui` (default)   |
| Синхронизация с внешней системой           | `integration-sync`      |
| Интеграция с initial setup (миграция)      | `integration-with-migration` |
| Мигратор с минимальным UI                  | `migrator-light`        |
| Отладка / разработка                       | `development`           |

Полное описание профилей: [telemetry-profiles-config.md](telemetry-profiles-config.md)

---

## 5. Lifecycle события

Lifecycle события описывают установку, регистрацию и удаление приложения. Они отправляются **один раз** в ключевых точках жизненного цикла.

### `app_installed` — установка приложения

```php
// AppLifecycleController::install()
$this->telemetry->trackEvent('app_installed', [
    'app.version'             => (string) $b24ApplicationInfo->VERSION,
    'app.status'              => $b24ApplicationStatus->getStatusCode(),  // free/trial/paid/local
    'portal.license_family'   => $b24PortalLicenseFamily,
    'portal.users_count'      => (string) $b24PortalUsersCount,
    'portal.member_id'        => $frontendPayload->memberId,
    'portal.domain'           => $frontendPayload->domain,
    'installer.user_id'       => (string) $b24CurrentUserProfile->ID,
    'installer.is_admin'      => $b24CurrentUserProfile->ADMIN ? 'true' : 'false',
]);
```

### `app_install_failed` — ошибка установки

```php
// AppLifecycleController::install() — catch блок
$this->telemetry->trackError($throwable, [
    'error.category'   => 'app_install_failed',
    'portal.member_id' => $frontendPayload->memberId ?? 'unknown',
    'portal.domain'    => $frontendPayload->domain ?? 'unknown',
]);
```

### `event_subscription_registered` — регистрация обработчиков событий

```php
// После bindEventHandlers
$this->telemetry->trackEvent('event_subscription_registered', [
    'portal.member_id'           => $frontendPayload->memberId,
    'portal.domain'              => $frontendPayload->domain,
    'registration.handler_url'   => $eventHandlerUrl,
    'registration.events_count'  => '2',
]);
```

### `app_install_finalized` — финализация установки

```php
// AppLifecycleEventController::process() — OnApplicationInstall
$this->telemetry->trackEvent('app_install_finalized', [
    'portal.member_id' => $memberId,
    'portal.domain'    => $domain,
]);
```

### `app_uninstalled` — удаление приложения

```php
// AppLifecycleEventController::process() — OnApplicationUninstall
$this->telemetry->trackEvent('app_uninstalled', [
    'portal.member_id' => $memberId,
    'portal.domain'    => $domain,
]);
```

---

## 6. UI события

UI события отправляются при каждом запросе от фронтенда. Профиль `simple-ui` всегда включает их.

### `app_opened` — открытие виджета

```php
// ApiController::getList() — controller uses SessionContextTrait
$this->telemetry->trackEvent('app_opened', [
    'ui.endpoint'      => '/api/list',
    'ui.method'        => $request->getMethod(),
    'session.id'       => $this->getSessionId($request),
    'portal.member_id' => $this->getMemberIdFromRequest($request),
    'portal.domain'    => $this->getDomainFromRequest($request),
]);
```

### Автоматический `session.id`

`session.id` проставляется автоматически через `TelemetryRequestSubscriber` при каждом запросе:

```php
// EventSubscriber/TelemetryRequestSubscriber.php — делает это автоматически
// 1. Читает заголовок X-Session-ID (если передан с фронта)
// 2. Или генерирует uuid4 для нового сеанса
// 3. Сохраняет в request attributes как 'telemetry_session_id'
```

В контроллерах, использующих `SessionContextTrait`, достаточно вызвать:

```php
$sessionId = $this->getSessionId($request);
```

---

## 7. Action и API события

### `b24_event_processed` — обработка события Bitrix24

```php
// B24EventsController::processEvent()
$actionStartTime = hrtime(true);

// ... бизнес-логика ...

$actionDurationMs = (int) round((hrtime(true) - $actionStartTime) / 1_000_000);

$this->telemetry->trackEvent('b24_event_processed', [
    'action.name'        => 'process_crm_contact_add',
    'action.type'        => 'b24_event_handler',
    'action.status'      => 'completed',
    'action.duration_ms' => (string) $actionDurationMs,
    'b24.event'          => OnCrmContactAdd::CODE,
    'b24.entity'         => 'contact',
    'portal.member_id'   => $b24Event->getAuth()->member_id,
]);
```

### `bitrix_api_call` — вызов Bitrix24 REST API

```php
$apiCallStart = hrtime(true);

$b24Contact = $sb->getCRMScope()->contact()->get($contactId)->contact();

$apiDurationMs = (int) round((hrtime(true) - $apiCallStart) / 1_000_000);

$this->telemetry->trackEvent('bitrix_api_call', [
    'api.provider'    => 'bitrix24',
    'api.method'      => 'crm.contact.get',
    'api.duration_ms' => (string) $apiDurationMs,
    'api.status'      => 'success',
    'portal.domain'   => $b24Account->getDomainUrl(),
]);
```

### Отслеживание ошибок

```php
try {
    // ... операция ...
} catch (\Throwable $e) {
    $this->telemetry->trackError($e, [
        'error.category'  => 'api_error',   // validation_error / auth_error / not_found / api_error / internal_error
        'action.name'     => 'crm_contact_get',
        'portal.member_id' => $memberId,
    ]);
    throw $e;
}
```

Необработанные исключения перехватываются автоматически через `TelemetryExceptionListener`.

---

## 8. Замер длительности операций (trackOperation)

`trackOperation()` — метод для замера времени выполнения операции с записью результата в `otel_traces` (а не в `otel_logs`). Используйте его вместо ручного `hrtime()`, когда нужны точные данные о длительности, видимые в Grafana.

### Когда использовать

| Сценарий | Метод |
|---|---|
| Бизнес-событие (кнопка, установка) | `trackEvent()` → `otel_logs` |
| Ошибка / исключение | `trackError()` → `otel_logs` |
| Вызов внешнего API (Bitrix24, AI, шлюз) | `trackOperation()` → `otel_traces` |
| Тяжёлая операция с замером времени | `trackOperation()` → `otel_traces` |
| Цепочка операций (нужен flame-graph) | `trackOperation()` → `otel_traces` |

### Сигнатура

```php
/**
 * @template T
 * @param callable(): T $operation
 * @return T
 */
public function trackOperation(string $name, callable $operation, array $attributes = []): mixed;
```

- Возвращает результат `$operation()` без изменений
- При исключении: записывает исключение в span и пробрасывает его дальше
- При `TELEMETRY_ENABLED=false` (`NullTelemetryService`): просто вызывает `$operation()`, без overhead

### Базовый пример — вызов Bitrix24 API

```php
// До: ручной hrtime() + отдельный trackEvent
$apiStart = hrtime(true);
$contact = $sb->getCRMScope()->contact()->get($contactId)->contact();
$apiDurationMs = (int) round((hrtime(true) - $apiStart) / 1_000_000);
$this->telemetry->trackEvent('bitrix_api_call', [
    'api.method'      => 'crm.contact.get',
    'api.duration_ms' => $apiDurationMs,
    'api.status'      => 'success',
]);

// После: trackOperation — компактно, автоматический замер, ошибки записываются сами
$contact = $this->telemetry->trackOperation(
    'bitrix24.crm.contact.get',
    fn () => $sb->getCRMScope()->contact()->get($contactId)->contact(),
    ['portal.member_id' => $memberId, 'b24.contact_id' => (string) $contactId],
);
```

### Вложенные операции

`trackOperation()` поддерживает вложенность: каждый span привязывается к контексту родительского через `$span->activate()`. В Grafana это отображается как waterfall-диаграмма.

```php
// Внешний span: вся обработка события
$this->telemetry->trackOperation('b24.onCrmContactAdd', function () use ($contactId, $memberId, $sb) {

    // Вложенный span: чтение данных из Bitrix24
    $contact = $this->telemetry->trackOperation(
        'bitrix24.crm.contact.get',
        fn () => $sb->getCRMScope()->contact()->get($contactId)->contact(),
        ['b24.contact_id' => (string) $contactId],
    );

    // Вложенный span: запись в локальную БД
    $this->telemetry->trackOperation(
        'db.contact.upsert',
        fn () => $this->contactRepository->upsert($contact),
        ['db.table' => 'contacts'],
    );

}, ['portal.member_id' => $memberId]);
```

### Комбинирование с trackEvent

`trackOperation()` и `trackEvent()` не исключают друг друга. Типичная комбинация:

```php
// 1. Высокоуровневое событие в otel_logs (для продуктовой аналитики)
$this->telemetry->trackEvent('action_initiated', [
    'action.name'      => 'create_crm_lead',
    'session.id'       => $sessionId,
    'portal.member_id' => $memberId,
]);

// 2. Технические замеры в otel_traces (для мониторинга производительности)
$result = $this->telemetry->trackOperation(
    'bitrix24.crm.lead.add',
    fn () => $sb->getCRMScope()->lead()->add($leadData),
    ['portal.member_id' => $memberId],
);

// 3. Результат в otel_logs
$this->telemetry->trackEvent('action_completed', [
    'action.name'   => 'create_crm_lead',
    'action.status' => 'completed',
    'b24.lead_id'   => (string) $result->getId(),
    'session.id'    => $sessionId,
]);
```

---

## 9. Инъекция сервиса телеметрии

### В контроллере

```php
use App\Service\Telemetry\TelemetryInterface;
use App\Service\Telemetry\SessionContextTrait;

class ApiController extends AbstractController
{
    use SessionContextTrait;

    public function __construct(
        private readonly TelemetryInterface $telemetry,
        // другие зависимости
    ) {}

    #[Route('/api/list', methods: ['GET'])]
    public function getList(Request $request): JsonResponse
    {
        $this->telemetry->trackEvent('app_opened', [
            'ui.endpoint' => '/api/list',
            'ui.method'   => 'GET',
            'session.id'  => $this->getSessionId($request),
        ]);

        // ... бизнес-логика ...
    }
}
```

### В сервисе

```php
use App\Service\Telemetry\TelemetryInterface;

final class MyBusinessService
{
    public function __construct(
        private readonly TelemetryInterface $telemetry,
    ) {}

    public function processAction(string $actionName, array $params): array
    {
        try {
            // Внешний вызов оборачиваем в trackOperation — автоматический замер + запись в otel_traces
            $result = $this->telemetry->trackOperation(
                'service.' . $actionName,
                fn () => $this->doProcess($params),
                ['action.name' => $actionName],
            );

            $this->telemetry->trackEvent('action_completed', [
                'action.name'   => $actionName,
                'action.status' => 'completed',
            ]);

            return $result;
        } catch (\Throwable $e) {
            $this->telemetry->trackError($e, [
                'error.category' => 'internal_error',
                'action.name'    => $actionName,
            ]);
            throw $e;
        }
    }
}
```

### Symfony DI (автоматическая конфигурация)

Symfony autowiring автоматически подставляет `TelemetryInterface`. Ручная конфигурация в `services.yaml` не нужна — сервис зарегистрирован через `TelemetryFactory`.

---

## 10. Фронтенд-события (Nuxt → PHP)

> Полная документация: [telemetry-frontend-events.md](telemetry-frontend-events.md)

События из браузера отправляются через PHP-прокси `POST /api/telemetry/event` — это обеспечивает JWT-авторизацию, whitelist и обогащение атрибутами.

### Отправка события из Vue-компонента

```ts
// app/composables/useTelemetry.ts уже подключён глобально
const { track } = useTelemetry()

// Нажатие кнопки
function onSave() {
  track('ui_button_click', {
    'ui.component': 'btn-save',
    'ui.context': 'deal-form',
  })
  // ... бизнес-логика
}

// Отправка формы
function onSubmit() {
  track('ui_form_submit', {
     'ui.form': 'create-deal',
  })
}
```

### Допустимые события (whitelist)

Список задан в `config/packages/telemetry.yaml`:

| event_name | Когда
|---|---
| `page_view` | Переход на страницу (автоматически через плагин)
| `ui_button_click` | Клик по кнопке
| `ui_select_change` | Изменение поля выбора / дропдауна
| `ui_form_submit` | Отправка формы
| `ui_error` | JS-ошибка (автоматически через плагин)
| `app_frame_loaded` | Загрузка приложения (автоматически через плагин)
| `b24_api_call` | Вызов REST API / placement API Bitrix24 из фронтенда

### Расширение whitelist

```yaml
# config/packages/telemetry.yaml
parameters:
  telemetry.frontend_event_whitelist:
    - 'page_view'
    - 'ui_button_click'
    - 'ui_select_change'
    - 'ui_form_submit'
    - 'ui_error'
    - 'app_frame_loaded'
    - 'b24_api_call'
    - 'crm_deal_opened'   # ← ваше событие
```

---

## См. также

- [telemetry-integration-points.md](telemetry-integration-points.md) — все точки интеграции с атрибутами
- [telemetry-profiles-config.md](telemetry-profiles-config.md) — конфигурация профилей
- [telemetry-examples-ui-apps.md](telemetry-examples-ui-apps.md) — готовые примеры для разных типов приложений
- [telemetry-troubleshooting.md](telemetry-troubleshooting.md) — решение типичных проблем
- [telemetry-frontend-events.md](telemetry-frontend-events.md) — фронтенд-события через PHP-прокси (Sprint 8)
