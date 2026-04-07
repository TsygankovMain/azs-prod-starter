# Точки интеграции телеметрии — b24-ai-starter-ru (тип 1: UI-Centric)

> Sprint 5. Документ описывает все точки, в которых приложение отправляет телеметрические события.  
> Профиль по умолчанию: `simple-ui` (Lifecycle + UI атрибуты).

---

## 1. Lifecycle события

### `app_installed`
**Где**: `AppLifecycleController::install()`  
**Когда**: Успешная установка приложения (шаг 1 — сохранение токенов)  
**Атрибуты**:

| Атрибут                | Источник                                        |
|------------------------|-------------------------------------------------|
| `app.version`          | `(string) $b24ApplicationInfo->VERSION`         |
| `app.status`           | `$b24ApplicationStatus->getStatusCode()` (free/trial/paid/local) |
| `portal.license_family` | `$b24PortalLicenseFamily` \*                   |
| `portal.users_count`   | `(string) $b24PortalUsersCount` \*              |
| `portal.member_id`     | `$frontendPayload->memberId`                    |
| `portal.domain`        | `$frontendPayload->domain`                      |
| `installer.user_id`    | `(string) $b24CurrentUserProfile->ID` \*        |
| `installer.is_admin`   | `$b24CurrentUserProfile->ADMIN` (bool→string) \* |

> \* Атрибуты `portal.license_family`, `portal.users_count`, `installer.user_id`, `installer.is_admin` отсутствуют в `LifecycleProfile` и `UIProfile`, поэтому при использовании профиля `simple-ui` они **фильтруются** `AttributeGroupManager` и не попадают в OTel Collector.

---

### `app_install_failed`
**Где**: `AppLifecycleController::install()` — catch блок  
**Когда**: Ошибка при установке  
**Реализация**: `trackError($throwable, [...])` → `otel_logs` с `telemetry.channel = 'support'`  
**Атрибуты**: `error.category = 'app_install_failed'`, `portal.member_id`, `portal.domain`

---

### `event_subscription_registered`
**Где**: `AppLifecycleController::install()` — после bindEventHandlers  
**Когда**: Успешная регистрация обработчиков событий  
**Атрибуты**: `portal.member_id`, `portal.domain`, `registration.handler_url`, `registration.events_count` (всегда `'2'` — OnApplicationInstall + OnApplicationUninstall)

---

### `app_install_finalized`
**Где**: `AppLifecycleEventController::process()` — OnApplicationInstall  
**Когда**: Bitrix24 присылает application_token после установки  
**Атрибуты**: `portal.member_id`, `portal.domain`

---

### `app_uninstalled`
**Где**: `AppLifecycleEventController::process()` — OnApplicationUninstall  
**Когда**: Пользователь удалил приложение из портала  
**Атрибуты**: `portal.member_id`, `portal.domain`

---

## 2. UI события

### `app_opened`
**Где**: `ApiController::getList()`  
**Когда**: Пользователь открывает виджет / приложение  
**Атрибуты**:

| Атрибут              | Источник                                            |
|----------------------|-------------------------------------|
| `ui.endpoint`        | строка маршрута                     |
| `ui.method`          | HTTP метод                          |
| `session.id`         | `SessionContextTrait::getSessionId($request)` |
| `portal.member_id`   | `SessionContextTrait::getMemberIdFromRequest($request)` |
| `portal.domain`      | `SessionContextTrait::getDomainFromRequest($request)` |

> **Примечание**: `getList()` также дополнительно отправляет `api_list_called` с атрибутами `endpoint`, `method`, `timestamp` (остаток от Sprint 1).

---

## 3. Action события

### `b24_event_action_initiated`
**Где**: `B24EventsController::processEvent()` — OnCrmContactAdd  
**Когда**: Начало обработки события Bitrix24  
**Атрибуты**: `action.name`, `action.type`, `action.status = 'initiated'`, `b24.event_code`, `portal.member_id`

---

### `b24_event_processed`
**Где**: `B24EventsController::processEvent()` — OnCrmContactAdd  
**Когда**: Успешная обработка события Bitrix24  
**Атрибуты**:

| Атрибут                | Источник                      |
|------------------------|-------------------------------|
| `action.name`          | `'process_crm_contact_add'`   |
| `action.type`          | `'b24_event_handler'`         |
| `action.status`        | `'completed'`                 |
| `action.duration_ms`   | `(string)` замер через `hrtime()` |
| `b24.event`            | `OnCrmContactAdd::CODE`       |
| `b24.entity`           | `'contact'`                   |
| `portal.member_id`     | из event auth                 |

---

### `b24_event_processing_failed`
**Где**: `B24EventsController::processEvent()` — catch блок  
**Когда**: Ошибка при обработке события  
**Реализация**: `trackError($throwable, [...])` → `otel_logs` с `telemetry.channel = 'support'`  
**Атрибуты**: `error.category = 'b24_event_processing_failed'`, `action.name = 'process_crm_event'`, `action.status = 'failed'`

---

## 4. API Call события

### `bitrix_api_call`  
**Когда**: Вызов Bitrix24 REST API  
**Атрибуты**:

| Атрибут              | Источник                  |
|----------------------|---------------------------|
| `api.provider`       | `'bitrix24'`              |
| `api.method`         | `'crm.contact.get'`       |
| `api.duration_ms`    | `(string)` замер через `hrtime()` |
| `api.status`         | `'success'` / `'error'`   |
| `portal.domain`      | `$b24Account->getDomainUrl()` |

> **Рекомендация**: Для вызовов API предпочтительно использовать `trackOperation()` (см. раздел 7) — он автоматически замеряет время и записывает данные в `otel_traces` с точными `StartTime`/`EndTime`/`Duration`.

---

## 5. Error события

### Автоматическое через `TelemetryExceptionListener`
**Где**: `EventListener/TelemetryExceptionListener.php`  
**Когда**: Любое необработанное исключение в HTTP запросе  
**Реализация**: `trackError($exception, ['error.category' => ..., 'request.path' => ...])`

**Категории**:
- `validation_error` — `InvalidArgumentException` или классы с `validation`/`constraint` в названии
- `auth_error` — классы с `auth`/`unauthorized`/`forbidden`/`jwt` в названии
- `not_found` — `NotFoundHttpException`
- `api_error` — `Bitrix24\SDK\Core\Exceptions\BaseException`
- `domain_error` — `\DomainException`
- `internal_error` — всё остальное

---

## 6. Session Context

### `session.id` через `TelemetryRequestSubscriber`
**Где**: `EventSubscriber/TelemetryRequestSubscriber.php`  
**Когда**: Каждый HTTP запрос  
**Логика**:
1. Читает `X-Session-ID` заголовок (если передан с фронта)
2. Или генерирует новый `uuid4` при первом запросе
3. Сохраняет в `RequestStack` / request attributes
4. Все события в рамках запроса получают одинаковый `session.id`

---

## 7. Трейсинг операций (otel_traces)

`trackOperation()` записывает данные в **`otel_traces`** (не в `otel_logs`). Это отдельный сигнал с полями `StartTime`, `EndTime`, `Duration`, `StatusCode`, `SpanAttributes`.

### Когда использовать вместо `trackEvent()`

| Нужно | Используйте |
|---|---|
| Зафиксировать факт события (UI, lifecycle) | `trackEvent()` → `otel_logs` |
| Зафиксировать ошибку | `trackError()` → `otel_logs` |
| Замерить длительность конкретной операции | `trackOperation()` → `otel_traces` |
| Построить waterfall / flame-graph | `trackOperation()` (вложенные вызовы) |

### Точки интеграции

| Место | Имя span'а (рекомендуемый формат) | Атрибуты |
|---|---|---|
| Bitrix24 REST API call | `bitrix24.<scope>.<method>` | `portal.member_id`, `b24.entity_id` |
| Внешний AI API | `ai.<provider>.<action>` | `ai.model`, `portal.member_id` |
| Внешний платёжный шлюз | `payment.<provider>.charge` | `portal.member_id` |
| SMS / уведомление | `notification.sms.send` | `portal.member_id` |
| DB / тяжёлая операция | `db.<table>.<action>` | `db.rows_affected` |
| Обработка B24 события | `b24.<eventCode>` | `portal.member_id`, `b24.event_code` |

### Пример

```php
// Вызов Bitrix24 API — span попадает в otel_traces с Duration
$contact = $this->telemetry->trackOperation(
    'bitrix24.crm.contact.get',
    fn () => $sb->getCRMScope()->contact()->get($contactId)->contact(),
    ['portal.member_id' => $memberId, 'b24.contact_id' => (string) $contactId],
);
```

### Структура span'а в ClickHouse

```
otel_traces
├── SpanName     = 'bitrix24.crm.contact.get'
├── ServiceName  = значение OTEL_SERVICE_NAME (по умолчанию 'b24-app')
├── Duration     = 142000000  (наносекунды → 142 мс)
├── StatusCode   = 'OK' / 'ERROR'
├── SpanAttributes['portal.member_id'] = '...'
├── TraceId      = '...'  (связывает spans одного запроса)
└── ParentSpanId = '...'  (иерархия вложенных spans)
```
