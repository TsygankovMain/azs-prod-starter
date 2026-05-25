# 2026-05-25 — Fix AZS pagination + In-app FAQ/UserGuide

## Context

Two issues raised:

1. **Bug:** Manager (reviewer) sees only 50 stations in the AZS filter even though the portal has more.
2. **Feature:** No in-app help. Users need a FAQ accessible via a `?` icon with HTML mockups matching the real interface. The operator (admin) AZS report mockup must be rendered in mobile layout.

## Part 1 — AZS pagination bug

### Root cause

`backends/node/api/src/dispatch/bitrixRestClient.js`:

- `callInternalOnce` returns `responsePayload.result ?? responsePayload` (line ~230). Bitrix24 places the `next` cursor at the top level of the response, alongside `result`. After this unwrapping the `next` field is lost.
- `parseListItems` (line ~21) reads `result?.next`, but `result` already holds the inner object `{ items: [...] }`, so `next` is always `null`.
- `listCrmItems` (line ~375) paginates via `start = page.next`. With `next` always null it stops after page 1 (50 items).

This affects every `crm.item.list` consumer that goes through `listCrmItems`, but the most user-visible symptom is the `/api/reports/azs-options` endpoint feeding the reviewer filter.

### Fix

Add a low-level `callRaw(method, params, ctx)` that returns the full Bitrix payload (`{ result, next, total, time }`) without unwrapping `.result`. Switch `listCrmItems` to use `callRaw` and read `next` from the top level. Other consumers of `call` keep their current behavior.

### Test

Add a unit test that stubs the fetch transport to return two pages (`{ result: { items: [{id:1}, ..., {id:50}] }, next: 50 }` then `{ result: { items: [{id:51}, ..., {id:73}] }, next: undefined }`) and asserts `listCrmItems` returns 73 items.

## Part 2 — FAQ / UserGuide

### Entry point

Icon `?` (B24-styled, `MdiHelpCircle`-equivalent) placed in the top-right of the header on every app page: `index`, `admin/[reportId]`, `reviewer`, `settings`. Click opens a Bitrix24 native right-side **slider** carrying the `HelpGuide.vue` component.

### Components

- `app/components/help/HelpButton.vue` — the `?` icon button.
- `app/composables/useHelpDrawer.ts` — opens/closes the slider with a `defaultRole` parameter (`admin` | `reviewer` | `settings`).
- `app/components/help/HelpGuide.vue` — the slider content. Renders a role tab switcher (B24Tabs) with three sections always available; opens on the role matching the page that triggered it.
- `app/components/help/MockupAdminReport.vue` — operator report mockup. **Wrapped in a mobile-phone frame** (~375px wide, rounded corners, status bar). Contains demo photo positions, "Сделать фото" buttons, status badge.
- `app/components/help/MockupReviewerDashboard.vue` — reviewer dashboard mockup (desktop). Date filter, AZS filter, status filter, table with rows.
- `app/components/help/MockupSettings.vue` — settings mockup (desktop). Card with SP mapping fields.
- `app/components/help/MockupPushNotification.vue` — Bitrix24 push notification card mockup.

All mockups use real `@bitrix24/b24ui-nuxt` components with frozen demo data so the visual matches the live UI.

### Content (Russian, draft)

**Администратор АЗС:**
1. Что такое ежедневный фото-отчёт и зачем он.
2. Как приходит push-уведомление в Bitrix24 (с мокапом push).
3. Как открыть задание (с мокапом admin/[reportId] на телефоне).
4. Как сделать фото — только камера, не галерея.
5. Что значат статусы DONE / EXPIRED.

**Управляющий:**
1. Где открыть дашборд (с мокапом reviewer).
2. Фильтры: дата / АЗС / статус.
3. Как запустить отчёт вручную для конкретной АЗС.
4. Чтение статусов и фото-результатов.

**Настройки приложения:**
1. Маппинг СП АЗС и СП Отчёт (с мокапом settings).
2. Поля «Администратор», «Обязательные фото», «Расписание».
3. Роли и приоритет.
4. Таймаут N и сдвиг X.

### Integration in pages

Add `<HelpButton :default-role="..." />` to the header area of each `.client.vue` page. Pass the page's natural role as default for tab selection.

## Out of scope

- Real admin/[reportId] mobile layout fixes (only the FAQ mockup is mobile; the real page stays as is, per user direction).
- Screenshots — fully replaced by static Vue mockups using B24 UI Kit.
- Manual verification step — user will check in their environment after push.

## Delivery

Single commit (or two: fix + feature). Push to `origin/master`.
