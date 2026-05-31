# Sprint 9: Redesign Reviewer Screen

## PM Summary

Goal:
- Simplify the reviewer (управляющий) screen so it can be used without training.
- Remove user-visible English status codes and technical jargon.
- Surface dispatch automation settings directly on the reviewer screen — no jump to Settings.

Done:
- Reviewer screen fully redesigned to match the approved hybrid mockup (Today summary + chronological event feed).
- Top: period switcher (Сегодня · Вчера · Неделя · Выбрать дату), date subtitle, main «Запросить отчёт сейчас» action.
- Summary banner: «Сдали отчёт N из M АЗС», multi-colour progress bar, three chip filters (Сдан / В работе / Не сдан) with active state and «Показать все».
- Event feed derived from existing `/api/reports` data:
  - Один отчёт даёт 1–2 события (создан + финал).
  - Иконка и цвет события — по статусу (бот рассылки, сдан, в работе, не сдан, ошибка, ручной запуск).
  - Inline-кнопки «Запросить повторно» и «Открыть фото» прямо на событии «не сдан».
  - Фильтр «Все события / Только проблемы».
- Right panel:
  - «Расписание рассылки» — chip-теги времён с удалением, разброс ±, время на сдачу, кнопка «Сохранить». Сохраняет через `/api/settings`.
  - «Запросить отчёт вне расписания» — выбор АЗС, режим «Прямо сейчас / Запланировать», отправка задания через `createManualReport`.
- Bottom: collapsible «Показать техническую информацию по отчётам» — старая таблица с id, слотами, папками, кнопками «Карточка отчёта» и «Папка фото» + «Проверка просроченных». Сохранена для технических пользователей.
- All user-visible labels in Russian. No occurrences of `done/in_progress/expired/failed/new` in template output.

Business result:
- Управляющий с первого взгляда видит загрузку дня и проблемные АЗС.
- Основное действие («Запросить отчёт сейчас») — одна кнопка в шапке.
- Настройки автоматики и ручной запуск находятся на одном экране — экономия на онбординге.
- Сложные технические детали не мешают повседневной работе, но остаются доступны при необходимости.

## Agent Notes

Files changed:
- `frontend/app/pages/reviewer.client.vue` — полная переработка (≈1067 строк, +892/-435 vs. предыдущий вариант).

Mockup reference:
- `docs/mockups/reviewer-screen.html` — standalone HTML-мокап, на котором основан финальный экран.

API usage:
- `apiStore.getReportsSummary({dateFrom, dateTo})` — данные для большой сводки.
- `apiStore.getReports({dateFrom, dateTo, limit: 200})` — источник для ленты событий.
- `apiStore.getAzsOptions({limit: 500})` — резолв id → название АЗС.
- `apiStore.getSettings()` / `apiStore.saveSettings(settings)` — чтение и сохранение расписания.
- `apiStore.createManualReport({candidates, slotDate, slotHHmm})` — ручной запрос отчёта.
- `apiStore.runTimeoutWatcher()` — кнопка «Проверка просроченных» в техническом блоке.

Status mapping (template-side only, backend семантика не менялась):

| Бэкенд | Управляющему показываем |
|---|---|
| `new` | Запланирован |
| `in_progress` | В работе |
| `done` | Сдан |
| `expired` | Не сдан |
| `failed` | Ошибка |

Verification:
- Visual: открыть `docs/mockups/reviewer-screen.html` в браузере → сравнить с реальным экраном после сборки.
- Grep: `grep -nE ">\\s*(done|in_progress|expired|failed|new)\\s*<|\\\"(done|in_progress|expired|failed)\\\"" frontend/app/pages/reviewer.client.vue` → 0 совпадений в пользовательском тексте.

Next sprint:
- Опциональное расширение ленты: добавить событие на загрузку каждого фото (требует расширения `/api/reports` или нового события).
- Real-time обновление ленты через polling/WebSocket (сейчас обновление по «Применить»/перезагрузке).
- Возможность сворачивать день в ленте при выборе «Неделя».
