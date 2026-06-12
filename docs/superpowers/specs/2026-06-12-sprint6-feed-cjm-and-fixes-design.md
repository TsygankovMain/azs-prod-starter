# Спринт 6 — «Фотолента CJM + баги» (дизайн/спека)

**Дата:** 2026-06-12 · **Статус:** утверждён продактом, в работе (subagent-driven).
**Ветка:** `feature/sprints-stability-ux`. Пуш/деплой в master — только по команде продакта.

Источник требований: продакт (чат 2026-06-12). BUG-022 — паркуем на уровне вебхука (техдолг, вне спринта).

---

## Состав

| # | Пункт | Слой | Размер |
|---|---|---|---|
| UX-1 | Фотолента → вкладка в окне проверяющего; старый вход (`/photos` + карточка) убрать | frontend | M |
| UX-2 | Пофотные замечания: свой коммент к каждому фото → одна «Отправить» → пачка отдельных сообщений | full-stack | L |
| BUG-021 | N+1 названий АЗС → `batchResolveAzsTitles` | backend | S |
| BUG-019 | COMMAND-кнопки бота (вариант B) | backend | L |

---

## UX-1 · Фотолента как вкладка проверяющего

**Сейчас:** окно проверяющего (`frontend/app/pages/reviewer.client.vue`) — монолит без вкладок. Фотолента — отдельная страница `/photos` (`photos.client.vue`), вход с карточки на главной (`index.client.vue`, `appScreens` key `photos`). Паттерн вкладок есть в отчётах (`components/reports/ReportNav.vue` + `activeTab` + `v-if`).

**Делаем:**
1. Вынести всё содержимое `photos.client.vue` (состояние + композиция `PhotoFilters`/`PhotoFeedGrid`/`RemarkJournal`/`PhotoLightbox`/`RemarkDraftPanel`) в компонент `frontend/app/components/photos/PhotoFeedView.vue`. Никакой логики не терять.
2. В `reviewer.client.vue` добавить строку вкладок: **«Дашборд»** (нынешнее содержимое) и **«Фотолента»** (`<PhotoFeedView/>`). Состояние вкладки — локальный `ref`, как `activeTab` в отчётах.
3. Удалить роут/страницу `/photos` и карточку «Фотолента» из `appScreens` в `index.client.vue`. Гейтинг доступа к вкладке — прежний (`reviewer | settings`).
4. Тест-раннера во фронте нет → проверка: `npm run lint` + ручной чек композиции. Не сломать вход reviewer/admin/azs.

## UX-2 · Пофотные замечания

**Поток (UI):** в лайтбоксе у текущего фото — поле коммента + «Отметить с замечанием». Отмеченные копятся в черновик-список `{reportId, photoCode, comment}` (панель снизу: список с возможностью править/удалить позицию). Один выбор получателя (`manager|admin`) на всю отправку, все фото — одной АЗС. Кнопка **«Отправить (N)»** → бэкенд шлёт N отдельных сообщений, каждое = фото + свой коммент. Быстрые шаблоны применяются к текущему фото.

**Контракт API (новый):**
```
POST /api/photo-remarks
body: {
  azsId: string,
  azsTitle?: string,
  recipientRole: "manager" | "admin",
  photos: Array<{ reportId: number, photoCode: string, comment: string }>  // 1..20, comment непустой
}
```
Никакого верхнеуровневого `message` — комментарий живёт внутри каждого фото.

**Store (`photo_remark` + `photo_remark_photo`):**
- `photo_remark` — метаданные отправки (azs, recipient, sender, created_at). Можно оставить.
- `photo_remark_photo` — добавить колонку `comment TEXT` и **пофотный** статус доставки: `delivery_status`, `delivery_error`. Миграция идемпотентная: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (PG) / проверка через information_schema (MySQL) — прод-данные не терять.
- Доставка/повтор — на уровне фото (каждое фото = своё сообщение со своим статусом).

**Service (`photoRemarkService.deliverRemark`):** цикл по фото; на каждое — одно im-сообщение (текст = его `comment`, вложение = это фото). Статус пишется в его `photo_remark_photo`-строку. `retryRemark` — переотправка конкретного фото (по `remarkId`+`reportId`+`photoCode`), не всей пачки.

**Journal (`RemarkJournal.vue` + GET):** каждое фото-замечание — отдельной позицией со своим статусом и кнопкой повтора недоставленного.

## BUG-021 · N+1 названий АЗС

`batchResolveAzsTitles(azsIds[], { context })` — один `crm.item.list({ entityTypeId, select:['id','title'], filter:{}, start:-1 })` → `Map<id,title>`. Подключить в горячих путях вместо поштучного `createAzsTitleResolver`: R2 (`analyticsRoutes.js`), R4/feed (`reportsRoutes.js`), фотолента (`photoFeedRoutes.js`). Поштучный резолвер оставить для одиночных мест (карточка/submit/upload). Файлы-зоны: `reportsRoutes.js`, `analyticsRoutes.js`, `photoFeedRoutes.js`. Ожидаемо: 15с → ~0.5с. **Не трогать** `bitrixRestClient.js` (зона BUG-019/общая).

## BUG-019 · COMMAND-кнопки бота (B)

**Решение по «Открыть приложение»:** убрать совсем (диплинка в Б24 нет — кнопка LINK выкидывает в внешний браузер). В тексте задания остаётся понятная подсказка «Откройте приложение „Порядок на АЗС“ в Битрикс24».

**«Указать причину» (задание и просрочка):** перевести с `LINK` на `COMMAND`-кнопку бота. По нажатию:
1. Бот ловит команду (`ONIMBOTMESSAGEADD` / command-обработчик) и отвечает в чате: «Напишите причину одним сообщением».
2. Бот запоминает состояние «жду причину по отчёту N» для этого пользователя/чата.
3. Следующее текстовое сообщение сотрудника интерпретируется как причина → пишется в отчёт/CRM (переиспользовать существующий reason-флоу: `dispatchErrorReasons`/`reasonStore`/reason-запись отчёта).
4. Бот подтверждает: «Причина принята».

**Файлы-зоны:** `reportLinks.js` (конструкция кнопок), `dispatchService.js` (keyboard), `notificationService.js`, `botRegistryService.js` (регистрация команды/события), `server.js` (маршрут/евент-хендлер команды), возможно новый `src/notifications/botCommandHandler.js` + стор состояния «жду причину». **Не трогать** `reportsRoutes.js`/`analyticsRoutes.js`/`photoFeedRoutes.js` (зона BUG-021) и `photoRemark*` (зона UX-2).

---

## Разбивка по агентам (волны)

**Волна 1 — параллельно, зоны файлов не пересекаются:**
- **A · Sonnet (backend):** BUG-021. Зона: `reportsRoutes.js`, `analyticsRoutes.js`, `photoFeedRoutes.js` + тесты. TDD.
- **B · Sonnet (backend):** UX-2 бэкенд. Зона: `photoRemarkService.js`, `photoRemarkRoutes.js`, `photoRemarkStore.js` + тесты + идемпотентная миграция. TDD.
- **C · Sonnet (backend):** BUG-019. Зона: `reportLinks.js`, `dispatchService.js`, `notificationService.js`, `botRegistryService.js`, `server.js`, новый `botCommandHandler.js` + тесты. TDD.
- **D · Sonnet (frontend):** UX-1. Зона: `reviewer.client.vue`, `index.client.vue`, `photos.client.vue`→`PhotoFeedView.vue`. lint.

**Волна 2 — после D и B (общая зона photos-фронта):**
- **E · Sonnet (frontend):** UX-2 фронт. Зона: `PhotoFeedView.vue`, `components/photos/*` (лайтбокс, черновик-панель, журнал), `stores/api.ts` по контракту из B. lint.

**Волна R — ревью:** пакеты Sonnet по каждой волне + Opus на интеграцию C (бот-команда) и UX-2 (end-to-end контракт).
**Волна F — Haiku:** CHANGELOG / RELEASES / bug-backlog «Закрыто» + заметка про `NUXT_PUBLIC_API_URL` в инструкции деплоя.

Оркестратор (Opus) запускает волны, ревьюит между ними, коммитит по зонам. Пуш/деплой — отдельно, по команде продакта.

## Зоны конфликтов (контроль оркестратора)
- `server.js` — только C.
- `bitrixRestClient.js` — НЕ трогать в волне 1 (если C нужен imbot-метод — через `bitrixClient.callMethod`, без правки клиента).
- photos-фронт (`PhotoFeedView.vue`, `components/photos/*`, `api.ts`) — D создаёт, E меняет → строго последовательно (D → E), не параллельно.
- Каждый агент правит ТОЛЬКО свою зону; выход за зону = стоп и доклад оркестратору.
