# Логический аудит «АЗС» + план устранения (для продакта)

**Дата:** 2026-06-12 · **Метод:** 4 параллельных агента-разведчика прошли краш-тест по зонам (dispatch/bot, reports/CRM/фото, settings/auth, фронт+маршруты). ~58 находок. Здесь — сведённый реестр с корнями и путями устранения, CJM/JTBD (граф в `2026-06-12-cjm-jtbd.drawio`) и состав спринта.

> Я не имею доступа к прод-логам. Где корень нельзя подтвердить только по коду — в плане стоит «нужна улика с прода» с точной командой.

---

## 0. Корень двух твоих живых жалоб (главное)

### A. «Сохранить плохо работает»
Сложилось из трёх независимых причин — лечить надо все:
1. **Разжалование админа через getToken (BUG-A1, HIGH).** `server.js` (getToken): если в теле приходит `ADMIN=false`/пусто, `pickFirstDefined` берёт это значение и **перезаписывает** сохранённый `isAdmin` вниз → у тебя пропадает `capabilities.settings` → сейв отдаёт 403 / кнопка выключена. Фронт раньше падал **молча** (уже залатал текст ошибки коммитом `725143e`), но корень — на бэке: разжаловать нельзя, только повышать.
2. **Хардкод супер-админа = userId 498 (BUG-A2, HIGH).** На фронте «разблокировка настроек» завязана на хардкод 498 (`settings.client.vue: applySystemAdminFallback`), а не на «я админ портала». Любой другой админ портала на свежем деплое видит «редактирование отключено».
3. **Сейв падает целиком при сбое Bitrix app.option (BUG-A3, MED).** `compositeSettingsStore.write` сначала пишет в Bitrix, и если тот моргнул — кидает ошибку, в БД **не сохраняет**. Транзиентный сбой Битрикса = «не сохранилось вообще».

→ После фикса A1+A2 «сохранить» перестанет зависеть от хардкода/разжалования; A3 убирает потерю при сбое Битрикса.

### B. «После причины ничего не происходит»
1. **id-рассинхрон кнопки (исправлено `8837e2e`).** Кнопка клала CRM-id вместо внутреннего — эффекты не находили отчёт. Закрыто.
2. **Стадия «Брак» не сохранена** — настройки не были сохранены (см. A). После фикса A — выбрать «ОТКАЗ ОТ ОТЧЕТА» и сохранить.
3. **BUG-024: отчёт рождается уже просроченным** — timeoutWatcher бракует карточку в ПРОСРОЧКУ через минуту после создания, ещё до ответа. Маскирует весь reason-флоу. См. ниже — это HIGH.

---

## 1. Реестр багов (сведён, дедуплицирован)

Severity: 🔴 HIGH · 🟡 MED · ⚪ LOW. Зона = что трогать.

### Дедлайны и жизненный цикл отчёта
| ID | Sev | Симптом | Корень (file:line) | Путь устранения |
|---|---|---|---|---|
| **BUG-024** | 🔴 | Отчёт «не сдан вовремя» через минуту после создания; «Сдать до» в прошлом | `deadlineAt` считается от планового слота (scheduled_at + jitter ±240), а не от фактической отправки. dispatchService.js:192-196; timeoutWatcher.js:79 | `deadlineAt = max(плановый, now()) + timeoutMinutes`; либо грейс-период: timeoutWatcher не бракует отчёты моложе timeoutMinutes |
| LOGIC-D2 | 🟡 | Ручной «Запросить сейчас» даёт неверный дедлайн (HHmm как UTC) | dispatchService.js:193 (`parseSlotDateTimeUtc` в ветке !precomputed) | Считать дедлайн в таймзоне настроек (как plan-генератор) |
| LOGIC-D3 | 🟡 | Последнее фото не переводит отчёт в «done» автоматически | reportsRoutes.js:1471 (`nextStatus='in_progress'` хардкод) | При allRequiredUploaded → 'done' (или явно документировать обязательный /submit) |

### Reason-флоу (бот → причина → браковка → CRM)
| ID | Sev | Симптом | Корень | Путь |
|---|---|---|---|---|
| LOGIC-R1 | 🟡 | Reason из бота не пишется в CRM, юзер видит «Принято» | reportItemId=null или `report.fields.reason` пуст → тихий skip; reportCrmSync.js:136-145; server.js onBotReasonCaptured | Вернуть пользователю/в лог `crmSynced:false`+причина; настроить UF-поле |
| LOGIC-R2 | 🟡 | Один юзер с 2+ открытыми отчётами: причина уходит не на тот | reasonCaptureStore ключ = userId:dialogId (без reportId); reasonCaptureStore.js:10 | Ключ userId:dialogId:reportId, либо переспрос «по какому отчёту» |
| LOGIC-R3 | 🟡 | Awaiting-состояние не истекает; после рестарта потеряно → причина «проглатывается» | reasonCaptureStore in-memory, без TTL; теряется при рестарте | TTL 24ч + персист в БД (или хотя бы TTL) |
| LOGIC-R4 | ⚪ | Reason записан, но отчёт не найден → молча ничего | server.js onBotReasonCaptured ранний return без лога | `logger.warn('bot_reason_report_not_found')` |
| LOGIC-R5 | ⚪ | Гонка timeoutWatcher × onBotReasonCaptured → двойная запись стадии в CRM | server.js:311 + timeoutWatcher.js:95 | Перечитать статус перед CRM-записью; не бить если уже expired |
| LOGIC-R6 | 🟡 | На странице причины пусто, если reasons не настроены — тупик | reason/[reportId].client.vue:259 | Фоллбек свободного текста (code other) + кнопка «Назад» |

### Авторизация / роли / безопасность
| ID | Sev | Симптом | Корень | Путь |
|---|---|---|---|---|
| **BUG-A1** | 🔴 | Админ теряет доступ к настройкам (разжалован) | getToken: тело `ADMIN=false` перезаписывает isAdmin вниз; server.js:869-882 | Разрешать только **повышение**; не разжаловать по телу запроса |
| **BUG-A2** | 🔴 | Только userId 498 — супер-админ; другие админы портала не могут настраивать | roleResolver.js:4 (хардкод); settings.client.vue applySystemAdminFallback (хардкод 498) | env `SYSTEM_ADMIN_USER_IDS` (default []); фронт-разблокировка по `userStore.isAdmin`, не по 498 |
| **BUG-S1** | 🔴 | `/api/install` ставит isAdmin:true любому вызвавшему; нет верификации | server.js:728-737 (без application_token) | Проверять `application_token` Битрикса; isAdmin только при profile.ADMIN |
| **BUG-S2** | 🔴 | `/api/bot/event` открыт, если `JOB_SECRET` пуст — спуфинг причин | server.js:623-638; warn один раз, но продолжает | JOB_SECRET обязателен в bot-режиме (fail-closed при пустом) + application_token |
| LOGIC-A4 | 🟡 | Admin-context refresh не освежает при пустом `refreshTokenIssuedAt` (старые записи) | tokenRefreshScheduler.js:61-65 (continue) | Для age=null — форс-refresh один раз |
| LOGIC-A5 | 🟡 | Свежий деплой без env-ролей и без profile.ADMIN → нет ни одного админа (дедлок) | roleResolver.js:58-68 | Док: на install требовать ADMIN_USER_IDS env или profile.ADMIN |

### Настройки (сохранение/хранение)
| ID | Sev | Симптом | Корень | Путь |
|---|---|---|---|---|
| **BUG-A3** | 🟡 | Сейв падает целиком при сбое Bitrix app.option, в БД не пишет | compositeSettingsStore.write:66-73 (throw до dbStore) | `allSettled`: писать в БД независимо, падать только если оба упали |
| LOGIC-C2 | ⚪ | Стадии/поля не валидируются по типу — мусор проходит | defaultSettings.js:229 (только «это объект») | Валидировать строки стадий/полей |
| LOGIC-C3 | ⚪ | read пишет в БД на каждый запрос — нагрузка | compositeSettingsStore.read:47-52 | TTL-кэш 10-30с |

### CRM-синхронизация / фото
| ID | Sev | Симптом | Корень | Путь |
|---|---|---|---|---|
| **BUG-P1** | 🔴 | Отчёт «done», но в CRM 0 фото | buildReportPhotoFieldValue фильтрует без diskObjectId, тихо; reportCrmSync.js:52,105 | warn при потере фото; не закрывать «done» с пустым набором |
| **BUG-P2** | 🔴 | Превью вечно 502 (webhook пуст + admin-токен протух + invalid_client) | analyticsRoutes.js:113-130 | Отдавать 503 `preview_auth_broken`; health-чек webhook |
| **BUG-P3** | 🔴 | `/resync` шлёт `diskFolderId:null` → папка в CRM не пишется | dispatch_log нет колонки disk_folder_id; reportsRoutes.js:1658 | В /resync брать folderId из listPhotos, не из report |
| **BUG-P4** | 🔴 | commit-режим: фото без diskObjectId выпало из сообщения, но помечено «sent» | photoRemarkService.js:145-178 | Метить sent только реально вошедшие; остальные failed |
| LOGIC-P5 | 🟡 | retryPhoto не обновляет батч-статус замечания; в commit — дублирует сообщение | photoRemarkService.js:351-364 | После retry пересчитать батч; документировать commit-retry |
| **BUG-P6** | 🔴 | Multi-portal: фон берёт admin-контекст любого портала (getLastAdminContext без фильтра) | databaseAuthContextStore.js:61; buildCrmSyncRunner | Использовать resolveAdminCrmSyncContext с проверкой domain+memberId |
| LOGIC-P7 | 🟡 | Дашборд-счётчики (created_at) ≠ лента (updated_at) | reportsStore list vs getSummary | Единое каноничное поле (updated_at) везде |
| LOGIC-P8 | 🟡 | Парк >1000 АЗС: часть не получает рассылку; >2000 — без названий | limit 1000/2000 в loadEnabledAzsCandidates/batchResolveAzsTitles | Поднять лимит/курсор; warn при упоре |

### Фронт-UX
| ID | Sev | Симптом | Корень | Путь |
|---|---|---|---|---|
| **BUG-F1** | 🔴 | Проверяющий теряет весь черновик замечаний при переключении вкладки Дашборд↔Фотолента | PhotoFeedView размонтируется (v-if); состояние in-memory | `v-show` вместо `v-if` или поднять состояние в Pinia |
| LOGIC-F2 | 🟡 | Загрузка фото: одно фото не залилось → сдать нельзя, тупик | admin/[reportId].client.vue:163 (canSubmit требует !errors) | Эскейп: «указать причину» из экрана / supervisor-override |
| LOGIC-F3 | 🟡 | Ошибка отправки замечания в лайтбоксе невидима (тост под z-210) | PhotoFeedView.vue:301 | Показывать ошибку внутри панели лайтбокса |
| LOGIC-F4 | 🟡 | Проверяющий правит расписание без прав (нет settings-гейта) | reviewer.client.vue:478 saveSchedule | Гейт по capabilities.settings |
| LOGIC-F5 | ⚪ | Отметка из грида = пустой коммент → Send заблокирован, выглядит сломанным | PhotoFeedView.vue:629 | Отметка только с комментом / автоскролл к полю |
| LOGIC-F6 | 🟡 | azs_admin застрял на экране ожидания без навигации, если потерял роль | index.client.vue:474 | Кнопка «обновить роль»/выход |
| LOGIC-F7 | ⚪ | Фото >10МБ ловится только на confirm, после красивого превью | admin/[reportId].client.vue:551,588 | Качество 0.75-0.8 / даунскейл; внятный текст |

### Идемпотентность / прочее
| ID | Sev | Симптом | Корень | Путь |
|---|---|---|---|---|
| LOGIC-X1 | ⚪ | Дубль-доставка события Битрикса → двойная пересылка/CRM-запись (узкое окно) | server.js /api/bot/event без идемпотентности | Флаг in-progress по reportId / полагаться на upsert |
| LOGIC-X2 | ⚪ | Self-message бота не отфильтрован при гонке ре-регистрации (process.env.BITRIX_BOT_ID) | server.js:672 | Брать bot.id из payload события, не из env |
| LOGIC-X3 | ⚪ | crmSyncWorker стартует даже если recover() упал → застрявшие running | server.js:1018 | При ошибке recover — не стартовать/алертить |

---

## 2. CJM / JTBD (граф — `2026-06-12-cjm-jtbd.drawio`)

Три роли, их Jobs-To-Be-Done, happy-path и точки отказа (ссылки на баги выше):

- **Сотрудник АЗС (azs_admin)** — JTBD: «быстро отчитаться фото, что на АЗС порядок» / «если не успеваю — за 10 сек объяснить почему».
  Путь: бот-задание → открыть приложение → камера по слотам → загрузка → «Сдать». Альтернатива: «Не успеваю» → кнопки причин → принято.
  Отказы: BUG-024 (просрочен при рождении), LOGIC-F2 (фото не льётся — тупик), LOGIC-R6 (причины не настроены — тупик), LOGIC-F6 (застрял на ожидании).
- **Проверяющий (reviewer)** — JTBD: «с одного взгляда понять кто не сдал» / «ткнуть проблемное фото и отправить замечание ответственному».
  Путь: дашборд → кто не сдал → фотолента → отметить фото с комментом → выбрать получателя → отправить → журнал.
  Отказы: BUG-F1 (черновик теряется), LOGIC-F3 (ошибка невидима), LOGIC-P7/F-counters (цифры расходятся), BUG-P2 (превью 502).
- **Админ (admin)** — JTBD: «настроить смарт-процессы/поля/стадии/роли/расписание один раз и запустить рассылку».
  Путь: настройки (9 секций) → сохранить → план/рассылка → мониторинг.
  Отказы: BUG-A1/A2/A3 (сохранение), BUG-S1/S2 (безопасность), LOGIC-A5 (дедлок ролей).

---

## 3. Состав спринта (предложение)

Разбивка по волнам (зоны файлов не пересекаются → параллелим агентами; reason/CRM-зоны — последовательно).

**Спринт 7 «Логика и доступ» — приоритет блокеров пользователя:**

- **Волна 1 — ДОСТУП (разблокирует продакта, лечит «сохранить»):** BUG-A1 (getToken не разжаловать), BUG-A2 (env super-admin + фронт-фоллбек по isAdmin), BUG-A3 (сейв независимо от Bitrix). Зоны: server.js getToken, roleResolver.js, compositeSettingsStore.js, settings.client.vue/index.client.vue. Sonnet + TDD.
- **Волна 2 — ДЕДЛАЙН/ЦИКЛ (лечит «после причины ничего» по-настоящему):** BUG-024 (дедлайн от факта/грейс), LOGIC-D2 (ручной TZ), LOGIC-D3 (auto-done). Зона: dispatchService/timeoutWatcher/reportsRoutes. Sonnet + TDD.
- **Волна 3 — БЕЗОПАСНОСТЬ:** BUG-S1 (install verify), BUG-S2 (JOB_SECRET fail-closed + application_token capture). Зона: server.js install/getToken/bot-event. Sonnet + TDD.
- **Волна 4 — CRM/ФОТО надёжность:** BUG-P1 (0 фото), BUG-P3 (/resync папка), BUG-P4 (ложный sent), BUG-P6 (multi-portal контекст), BUG-P2 (превью 503 вместо вечного 502). Зона: reportCrmSync/photoRemarkService/analyticsRoutes/buildCrmSyncRunner. Sonnet + TDD.
- **Волна 5 — UX-блокеры:** BUG-F1 (черновик не терять), LOGIC-F2/F3/F4/F6 (эскейпы и гейты). Зона: фронт. Sonnet + lint.
- **Волна 6 — добор MED/LOW:** R1-R6, A4-A5, C2-C3, P5/P7/P8, X1-X3 — пакетом.
- **Ревью:** Opus на интеграцию волн 1-3 (доступ+безопасность — критично). **Docs (Haiku):** CHANGELOG/RELEASES/bug-backlog.

**Что снять с прода (для подтверждения корней, нужна твоя помощь):**
- Лог Timeweb: `grep -E "bot_reason|preview_failed|oauth_client_invalid|wrong_client"` после действий.
- Тело `/api/getToken` от фронта: есть ли `ADMIN`/`is_admin` и какое значение (подтвердить BUG-A1).
- Реально ли задан `JOB_SECRET` и `BITRIX_WEBHOOK_URL` в панели (BUG-S2/BUG-P2).

---

## 4. Принцип
Сначала ДОСТУП (волна 1) — без неё ты не можешь сохранить и проверить остальное. Потом ДЕДЛАЙН (волна 2) — без неё reason-флоу маскируется. Дальше безопасность и надёжность. UX и MED/LOW — добором.
