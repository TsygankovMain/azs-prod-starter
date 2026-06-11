# Фикс-спринт 5 — план исполнения (конвейер)

Спека: `docs/superpowers/specs/2026-06-11-fix-sprint-5-design.md` (источник требований/приёмки). Здесь — раскладка по агентам, файзонам и релизам.

## Волны и агенты

| Шаг | Агенты (модель) | Файзоны | Примечание |
|---|---|---|---|
| **FS5-W1** | A: W1-1+W1-2+self-heal (Sonnet) ∥ B: W1-3 (Sonnet) ∥ C: W1-4-ручка+кнопка (Sonnet) | A: dispatchService, timeoutWatcher, notificationService, dispatchLogStore · B: dispatchScheduler, errorCodes, useErrorText · C: server.js, botRegistryService, settings.client.vue | self-heal в send-path у A (импорт ensureBot, без правки botRegistry); guard ручной рассылки: если роут в server.js — B экспортирует хелпер, подключает волновой фикс |
| **FS5-R1** | Ревью A (Opus — канал бота) ∥ ревью B+C (Sonnet, пакет) ∥ диаг-013 (Sonnet) ∥ диаг-014 (Sonnet) | read-only | якорь диаг-013: лог «Disk download failed HTTP 401» (:16483); диаг-014 — майнинг того же лога + трасса кода |
| **FS5-F1** | Волновой фикс W1 (Sonnet) | по находкам | затем верификация (тесты×2, lint, build) → **гейт продакта: Релиз A** (merge в master ПО SHA конца W1, ветка едет дальше) |
| **FS5-W3/4** | W3-1 (Sonnet) ∥ W3-2 (Sonnet) ∥ W3-3 (Sonnet) ∥ W4-1 (Sonnet) ∥ W4-3 (Haiku) | reviewer.client.vue+бэк-выдача / reports.client.vue / server.js+stores / bitrixRestClient / R*.vue чипы | стартует параллельно FS5-F1 (зоны не пересекаются с W1) |
| **FS5-W2фикс** | W2-1 превью по диагнозу (Sonnet) ∥ W2-2 карточка по диагнозу (Sonnet) ∥ W4-2 подписи (Sonnet) | по развилке диагностики / reports-выборка / photos.client.vue+компоненты | W4-2 здесь же — общая photos-зона с W2-1-UX |
| **FS5-R2** | Ревью всех волн пакетами (Sonnet) + финальное интеграционное (Opus) | read-only | |
| **FS5-F2** | Финальный фикс + верификация + ВИЗУАЛЬНЫЙ ПРОГОН (DoD §8) + CHANGELOG + бэклог «Закрыто» | | → **гейт продакта: Релиз B** |

## Правила конвейера (как в спринте 4)

- Ветка `feature/sprints-stability-ux`; git add только своих путей; пуш/merge в master — только по команде продакта.
- Тесты: `cd backends/node/api && node --test "tests/*.test.js"` (glob, сейчас 400 зелёных); фронт `npm run lint`; build — контролёр на границах волн.
- Релиз A = merge master ← SHA финального коммита W1 (не tip ветки) — хвост спринта в релиз A не попадает.
- W1-Env (CLIENT_ID/SECRET в панели) — продакт, параллельно; двухфакторная приёмка волны 1 в спеке.

## Бюджет/модели

Sonnet — всё; Opus — ревью A (канал бота) + финальное интеграционное; Haiku — W4-3 чипы и CHANGELOG-черновик. Ожидаемо ~14 агентов, заметно легче спринта 4.
