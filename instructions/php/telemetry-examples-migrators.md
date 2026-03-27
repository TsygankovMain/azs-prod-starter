# Примеры телеметрии для приложений-миграторов (тип 3)

> Sprint 6.2 — Готовые примеры интеграции для типовых сценариев приложений-миграторов.  
> Профили: `migrator-light` (171 атрибут) и `migrator-advanced` (181 атрибут).

> **Два сигнала телеметрии:**  
> - `trackEvent()` / `trackError()` → **`otel_logs`** — бизнес-события, lifecycle, ошибки  
> - `trackOperation()` → **`otel_traces`** — замер длительности внешних вызовов (Trello API, Bitrix24 API, batch-операции)

---

## Содержание

1. [Установка мигратора](#1-установка-мигратора)
2. [Полный жизненный цикл миграции Trello → Bitrix24](#2-полный-жизненный-цикл-миграции-trello--bitrix24)
3. [Возобновление миграции после сбоя](#3-возобновление-миграции-после-сбоя)
4. [Liveness heartbeat — мониторинг живости процесса](#4-liveness-heartbeat--мониторинг-живости-процесса)
5. [Проверка покрытия (coverage check)](#5-проверка-покрытия-coverage-check)
6. [Внешние API-вызовы через trackOperation](#6-внешние-api-вызовы-через-trackoperation)
7. [Запросы ClickHouse для мониторинга миграции](#7-запросы-clickhouse-для-мониторинга-миграции)

---

## 1. Установка мигратора

Установка аналогична UI-приложению. Реальный код контроллера `AppLifecycleController`:

```php
// AppLifecycleController.php — успешная установка
$this->telemetry->trackEvent('app_installed', [
    'app.version'           => (string) $b24ApplicationInfo->VERSION,
    'app.status'            => $b24ApplicationStatus->getStatusCode(),
    'portal.license_family' => $b24PortalLicenseFamily,
    'portal.users_count'    => (string) $b24PortalUsersCount,
    'portal.member_id'      => $frontendPayload->memberId,
    'portal.domain'         => $frontendPayload->domain,
    'installer.user_id'     => (string) $b24CurrentUserProfile->ID,
    'installer.is_admin'    => $b24CurrentUserProfile->ADMIN ? 'true' : 'false',
]);

// Регистрация обработчиков событий
$this->telemetry->trackEvent('event_subscription_registered', [
    'portal.member_id'          => $frontendPayload->memberId,
    'portal.domain'             => $frontendPayload->domain,
    'registration.handler_url'  => $eventHandlerUrl,
    'registration.events_count' => '2',
]);
```

При ошибке установки:

```php
$this->telemetry->trackError($throwable, [
    'error.category'   => 'app_install_failed',
    'portal.member_id' => $frontendPayload->memberId ?? 'unknown',
    'portal.domain'    => $frontendPayload->domain ?? 'unknown',
]);
```

---

## 2. Полный жизненный цикл миграции Trello → Bitrix24

**Сценарий**: пользователь запускает одноразовую миграцию всего пространства Trello. Система проходит стадии: discovery → users → tasks → validation.

### Диаграмма событий

```
[пользователь нажал "Начать миграцию"]
    → migration_initiated

[начало обработки в фоне]
    → migration_started

[стадия: обнаружение данных]
    → migration_stage_started  (stage.name=discovery)
    → migration_stage_completed (stage.name=discovery)

[стадия: миграция пользователей]
    → migration_stage_started  (stage.name=users)
    → migration_item_processed × N
    → migration_stage_completed (stage.name=users)

[стадия: миграция задач — пакетная]
    → migration_stage_started  (stage.name=tasks)
    → migration_batch_started  × K
    → migration_batch_completed × K
    → migration_stage_completed (stage.name=tasks)

[миграция завершена]
    → coverage_check
    → migration_completed
```

### Контроллер — запуск миграции

```php
<?php

declare(strict_types=1);

namespace App\Controller;

use App\Service\Migration\TrelloMigrationService;
use App\Service\Telemetry\SessionContextTrait;
use App\Service\Telemetry\TelemetryInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Контроллер запуска миграции из Trello.
 */
final class TrelloMigrationController extends AbstractController
{
    use SessionContextTrait;

    public function __construct(
        private readonly TelemetryInterface $telemetry,
        private readonly TrelloMigrationService $migrationService,
    ) {}

    /**
     * Инициация миграции — пользователь нажал "Начать".
     * Возвращает migration_id для отслеживания прогресса.
     */
    #[Route('/migration/trello/start', methods: ['POST'])]
    public function start(Request $request): JsonResponse
    {
        $sessionId = $this->getSessionId($request);
        $memberId  = $this->getMemberIdFromRequest($request);
        $domain    = $this->getDomainFromRequest($request);

        $data        = $request->toArray();
        $migrationId = uniqid('mig_', true);

        // Пользователь инициировал миграцию
        $this->telemetry->trackEvent('migration_initiated', [
            'migration.id'             => $migrationId,
            'migration.type'           => $data['type'] ?? 'full',  // full, selective, test
            'migration.source_system'  => 'trello',
            'migration.trigger'        => 'user_initiated',
            'migration.status'         => 'initiated',
            'migration.attempt_number' => '1',
            'session.id'               => $sessionId,
            'portal.member_id'         => $memberId,
            'portal.domain'            => $domain,
        ]);

        // Передаём в очередь / Symfony Messenger
        $this->migrationService->enqueue($migrationId, $memberId, $sessionId, $data);

        return $this->json(['migration_id' => $migrationId, 'status' => 'initiated']);
    }
}
```

### Сервис миграции — основной lifecycle

```php
<?php

declare(strict_types=1);

namespace App\Service\Migration;

use App\Service\Telemetry\TelemetryInterface;

/**
 * Сервис миграции из Trello в Bitrix24.
 *
 * Запускается в фоне (Symfony Messenger / cron).
 * Получает memberId и sessionId как параметры — не из Request.
 */
final class TrelloMigrationService
{
    public function __construct(
        private readonly TelemetryInterface $telemetry,
        private readonly TrelloApiClient $trello,
        private readonly \Bitrix24\SDK\Services\ServiceBuilder $serviceBuilder,
        private readonly MigrationRepository $repository,
    ) {}

    /**
     * Основной процесс миграции.
     */
    public function run(string $migrationId, string $memberId, string $sessionId, array $options): void
    {
        $processStart = hrtime(true);

        // Миграция стартовала
        $this->telemetry->trackEvent('migration_started', [
            'migration.id'             => $migrationId,
            'migration.type'           => $options['type'] ?? 'full',
            'migration.source_system'  => 'trello',
            'migration.status'         => 'running',
            'migration.attempt_number' => '1',
            'process.start_timestamp'  => (string) time(),
            'portal.member_id'         => $memberId,
            'session.id'               => $sessionId,
        ]);

        try {
            // --- Стадия 0: Discovery ---
            $this->runDiscoveryStage($migrationId, $memberId, $sessionId);

            // --- Стадия 1: Users ---
            $this->runUsersStage($migrationId, $memberId, $sessionId);

            // --- Стадия 2: Tasks (пакетная) ---
            $this->runTasksStage($migrationId, $memberId, $sessionId, $options);

            // --- Финальная проверка покрытия ---
            $this->runCoverageCheck($migrationId, $memberId, $sessionId);

            // Миграция завершена
            $totalMs = (int) round((hrtime(true) - $processStart) / 1_000_000);
            $this->telemetry->trackEvent('migration_completed', [
                'migration.id'                    => $migrationId,
                'migration.status'                => 'completed',
                'migration.outcome'               => 'success',
                'migration.completion_percentage' => '100',
                'migration.is_complete'           => 'true',
                'migration.can_resume'            => 'false',
                'process.end_timestamp'           => (string) time(),
                'process.duration_total_ms'       => (string) $totalMs,
                'portal.member_id'                => $memberId,
                'session.id'                      => $sessionId,
            ]);

        } catch (\Throwable $e) {
            $totalMs = (int) round((hrtime(true) - $processStart) / 1_000_000);
            $this->telemetry->trackEvent('migration_failed', [
                'migration.id'              => $migrationId,
                'migration.status'          => 'failed',
                'migration.outcome'         => 'failure',
                'migration.failure_reason'  => 'error',
                'migration.can_resume'      => 'true',
                'process.duration_total_ms' => (string) $totalMs,
                'portal.member_id'          => $memberId,
            ]);
            $this->telemetry->trackError($e, [
                'error.category'           => 'system_error',
                'error.source'             => 'internal',
                'error.is_retryable'       => 'true',
                'error.affects_completion' => 'true',
                'error.data_loss_risk'     => 'false',
                'migration.id'             => $migrationId,
                'portal.member_id'         => $memberId,
            ]);
            throw $e;
        }
    }

    /**
     * Стадия: discovery — получение структуры пространства Trello.
     */
    private function runDiscoveryStage(string $migrationId, string $memberId, string $sessionId): void
    {
        $stageId    = uniqid('stage_', true);
        $stageStart = hrtime(true);

        $this->telemetry->trackEvent('migration_stage_started', [
            'migration.id'     => $migrationId,
            'stage.id'         => $stageId,
            'stage.name'       => 'discovery',
            'stage.index'      => '0',
            'stage.status'     => 'running',
            'portal.member_id' => $memberId,
        ]);

        try {
            // Вызов Trello API через trackOperation (→ otel_traces)
            $boards = $this->telemetry->trackOperation(
                'trello.boards.list',
                fn () => $this->trello->getBoards(),
                ['migration.id' => $migrationId, 'portal.member_id' => $memberId],
            );

            $stageMs = (int) round((hrtime(true) - $stageStart) / 1_000_000);
            $this->telemetry->trackEvent('migration_stage_completed', [
                'migration.id'          => $migrationId,
                'stage.id'              => $stageId,
                'stage.name'            => 'discovery',
                'stage.index'           => '0',
                'stage.status'          => 'completed',
                'stage.duration_ms'     => (string) $stageMs,
                'stage.items_total'     => (string) count($boards),
                'stage.items_processed' => (string) count($boards),
                'stage.items_failed'    => '0',
                'portal.member_id'      => $memberId,
                'session.id'            => $sessionId,
            ]);

        } catch (\Throwable $e) {
            $stageMs = (int) round((hrtime(true) - $stageStart) / 1_000_000);
            $this->telemetry->trackEvent('migration_stage_failed', [
                'migration.id'      => $migrationId,
                'stage.id'          => $stageId,
                'stage.name'        => 'discovery',
                'stage.index'       => '0',
                'stage.status'      => 'failed',
                'stage.duration_ms' => (string) $stageMs,
                'portal.member_id'  => $memberId,
            ]);
            throw $e;
        }
    }

    /**
     * Стадия: users — перенос участников Trello в Bitrix24.
     */
    private function runUsersStage(string $migrationId, string $memberId, string $sessionId): void
    {
        $stageId        = uniqid('stage_', true);
        $stageStart     = hrtime(true);
        $itemsProcessed = 0;
        $itemsFailed    = 0;

        $this->telemetry->trackEvent('migration_stage_started', [
            'migration.id'     => $migrationId,
            'stage.id'         => $stageId,
            'stage.name'       => 'users',
            'stage.index'      => '1',
            'stage.status'     => 'running',
            'portal.member_id' => $memberId,
        ]);

        $trelloUsers = $this->trello->getMembers();

        foreach ($trelloUsers as $trelloUser) {
            try {
                // Создать пользователя в Bitrix24 (span в otel_traces)
                $this->telemetry->trackOperation(
                    'bitrix24.user.add',
                    fn () => $this->serviceBuilder->getUserScope()->user()->add([
                        'NAME'  => $trelloUser->fullName,
                        'EMAIL' => $trelloUser->email,
                    ]),
                    [
                        'migration.id'       => $migrationId,
                        'items.type'         => 'users',
                        'entity.external_id' => $trelloUser->id,
                        'portal.member_id'   => $memberId,
                    ],
                );

                $itemsProcessed++;
                $this->telemetry->trackEvent('migration_item_processed', [
                    'migration.id'       => $migrationId,
                    'stage.name'         => 'users',
                    'items.type'         => 'users',
                    'entity.external_id' => $trelloUser->id,
                    'entity.operation'   => 'create',
                    'entity.status'      => 'synced',
                    'portal.member_id'   => $memberId,
                ]);

            } catch (\Throwable $e) {
                $itemsFailed++;
                $this->telemetry->trackEvent('migration_item_failed', [
                    'migration.id'       => $migrationId,
                    'stage.name'         => 'users',
                    'items.type'         => 'users',
                    'entity.external_id' => $trelloUser->id,
                    'entity.status'      => 'failed',
                    'error.source'       => 'bitrix_api',
                    'error.is_retryable' => 'true',
                    'portal.member_id'   => $memberId,
                ]);
                // Единичный сбой не останавливает стадию — продолжаем
            }
        }

        $stageMs = (int) round((hrtime(true) - $stageStart) / 1_000_000);
        $this->telemetry->trackEvent('migration_stage_completed', [
            'migration.id'          => $migrationId,
            'stage.id'              => $stageId,
            'stage.name'            => 'users',
            'stage.index'           => '1',
            'stage.status'          => 'completed',
            'stage.duration_ms'     => (string) $stageMs,
            'stage.items_total'     => (string) count($trelloUsers),
            'stage.items_processed' => (string) $itemsProcessed,
            'stage.items_failed'    => (string) $itemsFailed,
            'items.type'            => 'users',
            'items.total_planned'   => (string) count($trelloUsers),
            'items.successful'      => (string) $itemsProcessed,
            'items.failed'          => (string) $itemsFailed,
            'portal.member_id'      => $memberId,
        ]);
    }

    /**
     * Стадия: tasks — пакетная обработка задач.
     */
    private function runTasksStage(string $migrationId, string $memberId, string $sessionId, array $options): void
    {
        $stageId         = uniqid('stage_', true);
        $stageStart      = hrtime(true);
        $batchSize       = 50;
        $offset          = $options['offset'] ?? 0;
        $batchIndex      = (int) ($offset / $batchSize);
        $totalSuccessful = 0;
        $totalFailed     = 0;

        $this->telemetry->trackEvent('migration_stage_started', [
            'migration.id'     => $migrationId,
            'stage.id'         => $stageId,
            'stage.name'       => 'tasks',
            'stage.index'      => '2',
            'stage.status'     => 'running',
            'portal.member_id' => $memberId,
        ]);

        do {
            $batchId    = uniqid('batch_', true);
            $batchStart = hrtime(true);

            // Загрузить пакет задач из Trello (span в otel_traces)
            $tasks = $this->telemetry->trackOperation(
                'trello.tasks.list',
                fn () => $this->trello->getTasks($batchSize, $offset),
                [
                    'migration.id' => $migrationId,
                    'batch.id'     => $batchId,
                    'batch.offset' => (string) $offset,
                    'batch.size'   => (string) $batchSize,
                    'portal.member_id' => $memberId,
                ],
            );

            $this->telemetry->trackEvent('migration_batch_started', [
                'migration.id' => $migrationId,
                'stage.name'   => 'tasks',
                'batch.id'     => $batchId,
                'batch.index'  => (string) $batchIndex,
                'batch.size'   => (string) count($tasks),
                'batch.offset' => (string) $offset,
                'batch.status' => 'running',
                'portal.member_id' => $memberId,
            ]);

            $batchSuccessful = 0;
            $batchFailed     = 0;

            foreach ($tasks as $task) {
                try {
                    $this->telemetry->trackOperation(
                        'bitrix24.tasks.task.add',
                        fn () => $this->serviceBuilder->getTasksScope()->tasks()->add([
                            'TITLE'          => $task->name,
                            'DESCRIPTION'    => $task->description,
                            'UF_EXTERNAL_ID' => $task->id,
                        ]),
                        [
                            'migration.id'       => $migrationId,
                            'items.type'         => 'tasks',
                            'entity.external_id' => $task->id,
                            'portal.member_id'   => $memberId,
                        ],
                    );
                    $batchSuccessful++;
                } catch (\Throwable $e) {
                    $batchFailed++;
                    $this->telemetry->trackEvent('migration_item_failed', [
                        'migration.id'       => $migrationId,
                        'stage.name'         => 'tasks',
                        'items.type'         => 'tasks',
                        'entity.external_id' => $task->id,
                        'entity.status'      => 'failed',
                        'error.source'       => 'bitrix_api',
                        'error.is_retryable' => 'true',
                        'portal.member_id'   => $memberId,
                    ]);
                }
            }

            $totalSuccessful += $batchSuccessful;
            $totalFailed     += $batchFailed;
            $batchMs          = (int) round((hrtime(true) - $batchStart) / 1_000_000);

            $this->telemetry->trackEvent('migration_batch_completed', [
                'migration.id'      => $migrationId,
                'stage.name'        => 'tasks',
                'batch.id'          => $batchId,
                'batch.index'       => (string) $batchIndex,
                'batch.size'        => (string) count($tasks),
                'batch.offset'      => (string) $offset,
                'batch.status'      => $batchFailed === 0 ? 'completed' : 'completed_with_errors',
                'batch.duration_ms' => (string) $batchMs,
                'items.successful'  => (string) $batchSuccessful,
                'items.failed'      => (string) $batchFailed,
                'portal.member_id'  => $memberId,
            ]);

            $offset     += $batchSize;
            $batchIndex++;
        } while (count($tasks) === $batchSize);

        $stageMs = (int) round((hrtime(true) - $stageStart) / 1_000_000);
        $this->telemetry->trackEvent('migration_stage_completed', [
            'migration.id'          => $migrationId,
            'stage.id'              => $stageId,
            'stage.name'            => 'tasks',
            'stage.index'           => '2',
            'stage.status'          => 'completed',
            'stage.duration_ms'     => (string) $stageMs,
            'stage.items_total'     => (string) ($totalSuccessful + $totalFailed),
            'stage.items_processed' => (string) ($totalSuccessful + $totalFailed),
            'stage.items_failed'    => (string) $totalFailed,
            'items.type'            => 'tasks',
            'items.successful'      => (string) $totalSuccessful,
            'items.failed'          => (string) $totalFailed,
            'portal.member_id'      => $memberId,
        ]);
    }
}
```

---

## 3. Возобновление миграции после сбоя

**Сценарий**: миграция упала на стадии `tasks`. При следующем запуске система обнаруживает незавершённую миграцию и продолжает с нужной стадии и смещения.

### Диаграмма событий

```
[обнаружена незавершённая миграция]
    → migration_initiated (migration.attempt_number=2, migration.retry_of=mig_prev)

[возобновление с tasks, offset=150]
    → migration_resumed (migration.resume_from_stage=tasks)

[обработка оставшихся пакетов]
    → migration_batch_started  (batch.offset=150)
    → migration_batch_completed
    → ...

[финал]
    → coverage_check
    → migration_completed (migration.attempt_number=2)
```

### Реализация

```php
/**
 * Возобновление прерванной миграции.
 *
 * @param string $previousMigrationId  ID предыдущей (упавшей) миграции
 * @param string $resumeFromStage      Стадия, с которой продолжить
 * @param int    $offsetInStage        Смещение внутри пакетной стадии
 * @param int    $attemptNumber        Номер попытки (2, 3, ...)
 */
public function resume(
    string $previousMigrationId,
    string $resumeFromStage,
    int $offsetInStage,
    string $memberId,
    string $sessionId,
    int $attemptNumber,
): void {
    $migrationId  = uniqid('mig_', true);
    $processStart = hrtime(true);

    // Инициируем повторную попытку
    $this->telemetry->trackEvent('migration_initiated', [
        'migration.id'                => $migrationId,
        'migration.type'              => 'full',
        'migration.source_system'     => 'trello',
        'migration.trigger'           => 'retry',
        'migration.status'            => 'initiated',
        'migration.attempt_number'    => (string) $attemptNumber,
        'migration.retry_of'          => $previousMigrationId,
        'migration.can_resume'        => 'true',
        'migration.resume_from_stage' => $resumeFromStage,
        'portal.member_id'            => $memberId,
        'session.id'                  => $sessionId,
    ]);

    // Сигнал возобновления — пропускаем завершённые стадии
    $this->telemetry->trackEvent('migration_resumed', [
        'migration.id'                => $migrationId,
        'migration.status'            => 'running',
        'migration.resume_from_stage' => $resumeFromStage,
        'migration.attempt_number'    => (string) $attemptNumber,
        'migration.retry_of'          => $previousMigrationId,
        'process.start_timestamp'     => (string) time(),
        'portal.member_id'            => $memberId,
    ]);

    try {
        // Продолжаем с нужной стадии (с сохранённым offset)
        match ($resumeFromStage) {
            'tasks'      => $this->runTasksStage($migrationId, $memberId, $sessionId, ['offset' => $offsetInStage]),
            'validation' => $this->runValidationStage($migrationId, $memberId, $sessionId),
            default      => throw new \InvalidArgumentException("Unknown resume stage: $resumeFromStage"),
        };

        $this->runCoverageCheck($migrationId, $memberId, $sessionId);

        $totalMs = (int) round((hrtime(true) - $processStart) / 1_000_000);
        $this->telemetry->trackEvent('migration_completed', [
            'migration.id'                    => $migrationId,
            'migration.status'                => 'completed',
            'migration.outcome'               => 'success',
            'migration.completion_percentage' => '100',
            'migration.is_complete'           => 'true',
            'migration.can_resume'            => 'false',
            'migration.attempt_number'        => (string) $attemptNumber,
            'migration.retry_of'              => $previousMigrationId,
            'process.duration_total_ms'       => (string) $totalMs,
            'portal.member_id'                => $memberId,
        ]);

    } catch (\Throwable $e) {
        $totalMs = (int) round((hrtime(true) - $processStart) / 1_000_000);
        $this->telemetry->trackEvent('migration_failed', [
            'migration.id'              => $migrationId,
            'migration.status'          => 'failed',
            'migration.outcome'         => 'failure',
            'migration.failure_reason'  => 'error',
            'migration.can_resume'      => 'true',
            'migration.attempt_number'  => (string) $attemptNumber,
            'migration.retry_of'        => $previousMigrationId,
            'process.duration_total_ms' => (string) $totalMs,
            'portal.member_id'          => $memberId,
        ]);
        $this->telemetry->trackError($e, [
            'error.category'           => 'system_error',
            'error.source'             => 'internal',
            'error.is_retryable'       => 'true',
            'error.affects_completion' => 'true',
            'migration.id'             => $migrationId,
            'portal.member_id'         => $memberId,
        ]);
        throw $e;
    }
}
```

---

## 4. Liveness heartbeat — мониторинг живости процесса

**Зачем нужно**: длительные миграции (часы) могут «зависнуть» без видимых ошибок. `liveness_check` события позволяют Grafana AlertManager обнаружить отсутствие прогресса.

### Диаграмма событий

```
[каждые N секунд внутри основного цикла]
    → liveness_check (process.is_stale=false, process.idle_duration_ms=...)

[если долго нет прогресса]
    → liveness_check (process.is_stale=true)
    → [алерт в Grafana: миграция зависла]
```

### Реализация

```php
<?php

declare(strict_types=1);

namespace App\Service\Migration;

use App\Service\Telemetry\TelemetryInterface;

/**
 * Трекер живости процесса миграции.
 *
 * Вызывается периодически — например, после каждого батча.
 * Grafana AlertManager обнаруживает зависание если сигналы прекращаются.
 */
final class MigrationLivenessTracker
{
    private int    $lastActivityTimestamp;
    private string $lastStageCompleted = 'none';
    private int    $heartbeatIntervalMs;

    public function __construct(
        private readonly TelemetryInterface $telemetry,
        int $heartbeatIntervalSeconds = 30,
    ) {
        $this->lastActivityTimestamp = time();
        $this->heartbeatIntervalMs   = $heartbeatIntervalSeconds * 1000;
    }

    /**
     * Зафиксировать активность (вызывать после каждого успешного батча/стадии).
     */
    public function recordActivity(string $stageName): void
    {
        $this->lastActivityTimestamp = time();
        $this->lastStageCompleted    = $stageName;
    }

    /**
     * Отправить liveness heartbeat в otel_logs.
     *
     * @param int $completionPercentage  0–100
     * @param int $staleThresholdSeconds Порог зависания (по умолчанию 5 минут)
     */
    public function heartbeat(
        string $migrationId,
        string $memberId,
        int $completionPercentage,
        int $staleThresholdSeconds = 300,
    ): void {
        $now              = time();
        $idleDurationMs   = ($now - $this->lastActivityTimestamp) * 1000;
        $staleThresholdMs = $staleThresholdSeconds * 1000;
        $isStale          = $idleDurationMs > $staleThresholdMs;

        $this->telemetry->trackEvent('liveness_check', [
            'migration.id'                    => $migrationId,
            'migration.completion_percentage' => (string) $completionPercentage,
            'process.last_heartbeat'          => (string) $now,
            'process.last_activity_timestamp' => (string) $this->lastActivityTimestamp,
            'process.last_stage_completed'    => $this->lastStageCompleted,
            'process.idle_duration_ms'        => (string) $idleDurationMs,
            'process.is_stale'                => $isStale ? 'true' : 'false',
            'process.stale_threshold_ms'      => (string) $staleThresholdMs,
            'process.heartbeat_interval_ms'   => (string) $this->heartbeatIntervalMs,
            'portal.member_id'                => $memberId,
        ]);
    }
}
```

### Использование в сервисе — после каждого батча

```php
// В runTasksStage() — после migration_batch_completed
$liveness->recordActivity('tasks');
$completionPercentage = $totalTasks > 0
    ? (int) (($offset / $totalTasks) * 100)
    : 0;
$liveness->heartbeat($migrationId, $memberId, $completionPercentage);
```

---

## 5. Проверка покрытия (coverage check)

**Зачем нужно**: RFC SLI-4 — подтвердить, что мигрировал требуемый процент объектов из источника. `coverage_check` создаёт итоговый снапшот метрик качества.

### Реализация

```php
/**
 * Финальная проверка покрытия миграции.
 *
 * Сравнивает объекты в Trello (источник) с импортированными в Bitrix24
 * и рассчитывает coverage percentage для каждого типа.
 */
private function runCoverageCheck(string $migrationId, string $memberId, string $sessionId): void
{
    // Количество объектов в источнике
    $detectedTasks = $this->trello->getTotalTasksCount();
    $detectedUsers = $this->trello->getTotalMembersCount();

    // Количество успешно импортированных (из собственного репозитория)
    $importedTasks = $this->repository->getImportedCount($migrationId, 'tasks');
    $importedUsers = $this->repository->getImportedCount($migrationId, 'users');
    $failedTasks   = $this->repository->getFailedCount($migrationId, 'tasks');
    $skippedTasks  = $this->repository->getSkippedCount($migrationId, 'tasks');

    // Покрытие задач
    $tasksCoverage = $detectedTasks > 0
        ? (int) round(($importedTasks / $detectedTasks) * 100)
        : 100;

    $tasksCoverageStatus = match (true) {
        $tasksCoverage >= 99 => 'full',
        $tasksCoverage >= 80 => 'partial',
        default              => 'failed',
    };

    $this->telemetry->trackEvent('coverage_check', [
        'migration.id'                    => $migrationId,
        'objects.type'                    => 'tasks',
        'objects.detected'                => (string) $detectedTasks,
        'objects.planned'                 => (string) $detectedTasks,
        'objects.imported'                => (string) $importedTasks,
        'objects.failed'                  => (string) $failedTasks,
        'objects.skipped'                 => (string) $skippedTasks,
        'coverage.percentage'             => (string) $tasksCoverage,
        'coverage.status'                 => $tasksCoverageStatus,
        'migration.completion_percentage' => (string) $tasksCoverage,
        'portal.member_id'                => $memberId,
        'session.id'                      => $sessionId,
    ]);

    // Покрытие пользователей
    $usersCoverage = $detectedUsers > 0
        ? (int) round(($importedUsers / $detectedUsers) * 100)
        : 100;

    $this->telemetry->trackEvent('coverage_check', [
        'migration.id'        => $migrationId,
        'objects.type'        => 'users',
        'objects.detected'    => (string) $detectedUsers,
        'objects.planned'     => (string) $detectedUsers,
        'objects.imported'    => (string) $importedUsers,
        'objects.failed'      => '0',
        'objects.skipped'     => '0',
        'coverage.percentage' => (string) $usersCoverage,
        'coverage.status'     => $usersCoverage >= 99 ? 'full' : 'partial',
        'portal.member_id'    => $memberId,
    ]);
}
```

---

## 6. Внешние API-вызовы через trackOperation

Тяжёлые операции мигратора — загрузка пагинированных батчей, bulk-создание записей — хорошо наблюдаются через `trackOperation()`. Данные попадают в `otel_traces` с точными `Duration`, `StartTime`, `EndTime` и waterfall-диаграммой в Grafana Tempo.

### Загрузка пагинированного батча из Trello

```php
// ✅ Загрузка пакета задач → span в otel_traces
$tasks = $this->telemetry->trackOperation(
    'trello.tasks.list',
    fn () => $this->trello->getTasks($batchSize, $offset),
    [
        'migration.id'     => $migrationId,
        'batch.id'         => $batchId,
        'batch.offset'     => (string) $offset,
        'batch.size'       => (string) $batchSize,
        'portal.member_id' => $memberId,
    ],
);
```

### Создание задачи в Bitrix24

```php
// ✅ Один вызов → отдельный span в otel_traces
$bitrix24TaskId = $this->telemetry->trackOperation(
    'bitrix24.tasks.task.add',
    fn () => $this->serviceBuilder->getTasksScope()->tasks()->add([
        'TITLE'          => $task->name,
        'DESCRIPTION'    => $task->description,
        'UF_EXTERNAL_ID' => $task->id,
    ]),
    [
        'migration.id'       => $migrationId,
        'items.type'         => 'tasks',
        'entity.external_id' => $task->id,
        'portal.member_id'   => $memberId,
    ],
);
```

### Вложенные spans — waterfall для всего батча

```php
// ✅ Внешний span охватывает батч целиком; вложенные — отдельные API-вызовы
$batchResult = $this->telemetry->trackOperation(
    'migration.tasks.batch',
    function () use ($tasks, $migrationId, $batchId, $memberId): array {
        $successful = 0;
        $failed     = 0;

        foreach ($tasks as $task) {
            try {
                // Загрузить вложения из Trello
                $attachments = $this->telemetry->trackOperation(
                    'trello.task.attachments.list',
                    fn () => $this->trello->getAttachments($task->id),
                    ['batch.id' => $batchId, 'entity.external_id' => $task->id],
                );

                // Создать задачу в Bitrix24
                $this->telemetry->trackOperation(
                    'bitrix24.tasks.task.add',
                    fn () => $this->serviceBuilder->getTasksScope()->tasks()->add([
                        'TITLE'       => $task->name,
                        'DESCRIPTION' => $task->description . "\n\nAttachments: " . count($attachments),
                    ]),
                    ['migration.id' => $migrationId, 'entity.external_id' => $task->id],
                );

                $successful++;
            } catch (\Throwable) {
                $failed++;
            }
        }

        return ['successful' => $successful, 'failed' => $failed];
    },
    [
        'migration.id'     => $migrationId,
        'batch.id'         => $batchId,
        'batch.size'       => (string) count($tasks),
        'portal.member_id' => $memberId,
    ],
);
```

> В Grafana Tempo waterfall покажет: `migration.tasks.batch` содержит N вложенных пар `trello.task.attachments.list` + `bitrix24.tasks.task.add`. Сразу видны медленные задачи, пики latency и ошибки.

---

## 7. Запросы ClickHouse для мониторинга миграции

После запуска примеров проверьте, что события попали в хранилище.  
Подключение: `clickhouse-client --host=localhost --port=9000 --user=default --password=changeme`

### Прогресс конкретной миграции

```sql
SELECT
    toDateTime(Timestamp)                        AS ts,
    LogAttributes['event.name']                  AS event_name,
    LogAttributes['migration.status']            AS status,
    LogAttributes['migration.completion_percentage'] AS pct,
    LogAttributes['stage.name']                  AS stage
FROM telemetry.otel_logs
WHERE LogAttributes['migration.id'] = 'mig_<ваш_id>'
ORDER BY Timestamp DESC
LIMIT 50;
```

### Производительность стадий по всем миграциям

```sql
SELECT
    LogAttributes['stage.name']        AS stage,
    count()                            AS runs,
    avg(toInt64OrZero(LogAttributes['stage.duration_ms'])) AS avg_ms,
    max(toInt64OrZero(LogAttributes['stage.duration_ms'])) AS max_ms,
    sum(toInt64OrZero(LogAttributes['stage.items_failed'])) AS total_failed
FROM telemetry.otel_logs
WHERE LogAttributes['event.name'] = 'migration_stage_completed'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY stage
ORDER BY avg_ms DESC;
```

### Покрытие по типам объектов

```sql
SELECT
    LogAttributes['objects.type']        AS object_type,
    LogAttributes['objects.detected']    AS detected,
    LogAttributes['objects.imported']    AS imported,
    LogAttributes['coverage.percentage'] AS coverage_pct,
    LogAttributes['coverage.status']     AS coverage_status,
    LogAttributes['migration.id']        AS migration_id
FROM telemetry.otel_logs
WHERE LogAttributes['event.name'] = 'coverage_check'
  AND Timestamp > now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC;
```

### Liveness check — обнаружение зависших миграций

```sql
SELECT
    toDateTime(Timestamp)                           AS ts,
    LogAttributes['migration.id']                  AS migration_id,
    LogAttributes['process.is_stale']              AS is_stale,
    LogAttributes['process.idle_duration_ms']      AS idle_ms,
    LogAttributes['process.last_stage_completed']  AS last_stage,
    LogAttributes['migration.completion_percentage'] AS pct
FROM telemetry.otel_logs
WHERE LogAttributes['event.name'] = 'liveness_check'
  AND LogAttributes['process.is_stale'] = 'true'
  AND Timestamp > now() - INTERVAL 1 HOUR
ORDER BY Timestamp DESC
LIMIT 20;
```

### Анализ ошибок — ретраябельность и риск потери данных

```sql
SELECT
    LogAttributes['error.source']             AS error_source,
    LogAttributes['error.is_retryable']       AS is_retryable,
    LogAttributes['error.data_loss_risk']     AS data_loss_risk,
    LogAttributes['error.affects_completion'] AS affects_completion,
    count()                                   AS error_count
FROM telemetry.otel_logs
WHERE SeverityText = 'ERROR'
  AND LogAttributes['migration.id'] != ''
  AND Timestamp > now() - INTERVAL 24 HOUR
GROUP BY error_source, is_retryable, data_loss_risk, affects_completion
ORDER BY error_count DESC;
```

### Waterfall производительности батчей (otel_traces)

```sql
SELECT
    toDateTime(Timestamp)                   AS ts,
    SpanName,
    Duration / 1e6                          AS duration_ms,
    SpanAttributes['batch.id']             AS batch_id,
    SpanAttributes['batch.size']           AS batch_size,
    SpanAttributes['entity.external_id']   AS entity_id,
    StatusCode
FROM telemetry.otel_traces
WHERE SpanAttributes['migration.id'] = 'mig_<ваш_id>'
ORDER BY Timestamp ASC
LIMIT 200;
```

---

## Общие паттерны

### Шаблон стадии с замером

```php
$stageId    = uniqid('stage_', true);
$stageStart = hrtime(true);

$this->telemetry->trackEvent('migration_stage_started', [
    'migration.id'     => $migrationId,
    'stage.id'         => $stageId,
    'stage.name'       => $stageName,
    'stage.index'      => (string) $stageIndex,
    'stage.status'     => 'running',
    'portal.member_id' => $memberId,
]);

try {
    // ... логика стадии ...

    $stageMs = (int) round((hrtime(true) - $stageStart) / 1_000_000);
    $this->telemetry->trackEvent('migration_stage_completed', [
        'migration.id'          => $migrationId,
        'stage.id'              => $stageId,
        'stage.name'            => $stageName,
        'stage.index'           => (string) $stageIndex,
        'stage.status'          => 'completed',
        'stage.duration_ms'     => (string) $stageMs,
        'stage.items_total'     => (string) $total,
        'stage.items_processed' => (string) $processed,
        'stage.items_failed'    => (string) $failed,
        'portal.member_id'      => $memberId,
    ]);

} catch (\Throwable $e) {
    $stageMs = (int) round((hrtime(true) - $stageStart) / 1_000_000);
    $this->telemetry->trackEvent('migration_stage_failed', [
        'migration.id'      => $migrationId,
        'stage.id'          => $stageId,
        'stage.name'        => $stageName,
        'stage.index'       => (string) $stageIndex,
        'stage.status'      => 'failed',
        'stage.duration_ms' => (string) $stageMs,
        'portal.member_id'  => $memberId,
    ]);
    throw $e;
}
```

### Ключевые значения атрибутов `migration.*`

| Атрибут | Допустимые значения | Описание |
|---------|--------------------|-|
| `migration.type` | `full`, `selective`, `test`, `dry_run` | Тип миграции |
| `migration.source_system` | `trello`, `jira`, `asana` | Источник данных |
| `migration.trigger` | `user_initiated`, `scheduled`, `retry` | Инициатор запуска |
| `migration.status` | `initiated`, `running`, `paused`, `completed`, `failed` | Текущий статус |
| `migration.outcome` | `success`, `failure`, `cancelled`, `timeout`, `partial_success` | Финальный итог |
| `migration.failure_reason` | `error`, `timeout`, `user_cancelled`, `resource_limit`, `validation_failed` | Причина сбоя |
| `migration.can_resume` | `true`, `false` | Можно ли возобновить |
| `migration.resume_from_stage` | Название стадии | С какой стадии продолжить |

### Ключевые значения `stage.name`

| Стадия | Что делает |
|--------|-----------|
| `discovery` | Получение структуры источника (доски, проекты, пространства) |
| `users` | Перенос пользователей и участников |
| `projects` | Перенос проектов, досок, пространств |
| `tasks` | Пакетный перенос задач (самая долгая стадия) |
| `attachments` | Перенос вложений и файлов |
| `validation` | Проверка целостности перенесённых данных |

### Значения `error.category` для миграторов

| Категория | Когда использовать |
|-----------|-------------------|
| `app_install_failed` | Ошибка при установке приложения |
| `system_error` | Общий внутренний сбой обработки |
| `api_error` | Ошибки Bitrix24 SDK или Trello/Jira API |
| `auth_error` | Протухшие токены (`AccessTokenRefreshException`) |
| `validation_error` | Некорректные данные в источнике |

> Атрибуты `error.is_retryable`, `error.affects_completion`, `error.data_loss_risk` — специфичные для миграторов булевы флаги. Устанавливайте **всегда** при `trackError()` в контексте миграции.

---

## Конфигурация

### docker-compose.yml

```yaml
services:
  api-php:
    environment:
      OTEL_TELEMETRY_PROFILE: migrator-light   # или migrator-advanced для dev
```

### Сброс кеша профилей после смены

```bash
docker compose exec api-php rm -rf var/cache/
docker compose restart api-php
```

---

## См. также

- [telemetry-quickstart.md](telemetry-quickstart.md) — быстрый старт и reference `trackOperation()`
- [telemetry-profiles-config.md](telemetry-profiles-config.md) — профили `migrator-light` / `migrator-advanced`
- [telemetry-integration-points.md](telemetry-integration-points.md) — полный список точек интеграции
- [telemetry-examples-ui-apps.md](telemetry-examples-ui-apps.md) — примеры для UI-приложений
- [telemetry-troubleshooting.md](telemetry-troubleshooting.md) — решение проблем
