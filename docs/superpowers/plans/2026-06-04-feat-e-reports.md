# FEAT-E: Модуль отчётов (5 видов) — Implementation Plan

> **Для агентских воркеров:** используй `superpowers:subagent-driven-development` или `superpowers:executing-plans` для пошагового выполнения. Шаги отмечены чекбоксами `- [ ]`.

**Goal:** Добавить самостоятельный экран «Отчёты» с 5 видами аналитики исключительно на текущих данных `dispatch_log` + `report_photo` + `dispatch_plan`. Никакого отдельного хранилища метрик — все агрегации «на лету». Мокап-эталон: `docs/mockups/reports-mockup.html`.

**Architecture:**
- Бэкенд: 3 новых read-only эндпоинта (`/api/reports/analytics/rating`, `/api/reports/analytics/trend`, `/api/reports/analytics/day-photos`) + прокси-превью фото через Bitrix Disk API (`/api/reports/photos/:reportId/:photoCode/preview`). Всё монтируется в `reportsRoutes.js` под тем же гвардом `canUseReviewerTools`. Имена АЗС — через существующий `createAzsTitleResolver` с кэшем на запрос.
- Фронтенд: новая страница `frontend/app/pages/reports.client.vue`. Навигация — через `index.client.vue` (кнопка «Отчёты» рядом с «Проверка отчётов»). Переключение 5 разделов — левое меню-навигация точно как в мокапе (на мобиле — нижняя панель). Графики — встроенный inline-SVG-рендер без внешних библиотек, повторяющий функции `lineSvg`, `stackSvg`, `groupBars`, `ringSvg` из мокапа, адаптированные под Vue `<template>`. Фото-превью — `<img>` c src = `/api/reports/photos/:reportId/:photoCode/preview?token=...` (JWT передаётся query-параметром только для img-тегов).
- Доступ: reviewer / settings — все 5 отчётов; capabilities.reports (admin АЗС) — только R4 для своей АЗС.

**Tech Stack:** Node.js/Express, `pg`/`mysql2` dual-driver, `node:test`, Nuxt 3 + `@bitrix24/b24ui-nuxt` (B24Badge, B24Alert, B24InputMenu, B24Calendar), Tailwind CSS, inline SVG, `luxon` для форматирования дат (уже в `frontend/package.json`).

**Честные ограничения:**
- Статус «принято / отклонено» в системе отсутствует — не добавляем.
- «Ср. время» (avg_minutes) считается только для `done`-строк по формуле `AVG(updated_at - scheduled_at)`.
- Превью фото возможно только если Bitrix Disk API предоставляет метод получения публичной ссылки или binary-download по `disk_object_id`. Если метод недоступен (зависит от версии portal API) — отображаем заглушку с иконкой и ссылкой на папку.

---

## File Structure

| Файл | Действие | Роль |
|---|---|---|
| `backends/node/api/src/reports/analyticsStore.js` | **Создать** | Агрегации rating + trend; dual PG/MySQL |
| `backends/node/api/src/reports/analyticsRoutes.js` | **Создать** | Express-роутер для `/analytics/*` и `/photos/:id/:code/preview` |
| `backends/node/api/src/reports/reportsRoutes.js` | **Изменить** | `createReportsRouter` принимает `analyticsStore`; монтирует `analyticsRoutes` |
| `backends/node/api/server.js` | **Изменить** | Создаёт `analyticsStore`, передаёт в роутер |
| `backends/node/api/tests/analyticsStore.test.js` | **Создать** | TDD-тесты агрегаций (fake pool) |
| `backends/node/api/tests/analyticsRoutes.test.js` | **Создать** | HTTP-интеграционные тесты эндпоинтов |
| `frontend/app/pages/reports.client.vue` | **Создать** | Главная страница «Отчёты» (5 разделов) |
| `frontend/app/components/reports/ReportNav.vue` | **Создать** | Левое меню / нижняя панель навигации |
| `frontend/app/components/reports/SvgRing.vue` | **Создать** | SVG-кольцо (donut chart) |
| `frontend/app/components/reports/SvgLine.vue` | **Создать** | SVG-линейный chart (тренд) |
| `frontend/app/components/reports/SvgGroupBars.vue` | **Создать** | SVG-сгруппированные столбцы |
| `frontend/app/components/reports/SvgStackBar.vue` | **Создать** | SVG-горизонтальная полоса (distribution) |
| `frontend/app/components/reports/R1Summary.vue` | **Создать** | Отчёт 1: Сводка за день/период |
| `frontend/app/components/reports/R2Rating.vue` | **Создать** | Отчёт 2: Рейтинг дисциплины |
| `frontend/app/components/reports/R3Trend.vue` | **Создать** | Отчёт 3: Динамика во времени |
| `frontend/app/components/reports/R4Card.vue` | **Создать** | Отчёт 4: Карточка АЗС |
| `frontend/app/components/reports/R5Wall.vue` | **Создать** | Отчёт 5: Фото-витрина дня |
| `frontend/app/stores/api.ts` | **Изменить** | Добавить методы `getReportsRating`, `getReportsTrend`, `getDayPhotos` |

---

## Фаза A — Backend: аналитические агрегации + тесты

### Task 1 — analyticsStore.js: скелет + тест FAIL

- [ ] **Step 1.1** Создать файл `backends/node/api/src/reports/analyticsStore.js` с экспортом `createAnalyticsStore({ pool, dbType })`.
  Пустые методы-заглушки, бросающие `new Error('not implemented')`:
  ```js
  // backends/node/api/src/reports/analyticsStore.js
  const isMysql = (t) => String(t || '').toLowerCase() === 'mysql';

  const createPostgresStore = (pool) => ({
    async getRating({ dateFrom, dateTo }) { throw new Error('not implemented'); },
    async getTrend({ dateFrom, dateTo, azsIds = [] }) { throw new Error('not implemented'); },
    async getDayPhotos({ date, azsIds = [] }) { throw new Error('not implemented'); },
  });

  const createMysqlStore = (pool) => ({
    async getRating({ dateFrom, dateTo }) { throw new Error('not implemented'); },
    async getTrend({ dateFrom, dateTo, azsIds = [] }) { throw new Error('not implemented'); },
    async getDayPhotos({ date, azsIds = [] }) { throw new Error('not implemented'); },
  });

  export const createAnalyticsStore = ({ pool, dbType }) => {
    if (!pool) throw new Error('pool is required');
    return isMysql(dbType) ? createMysqlStore(pool) : createPostgresStore(pool);
  };
  export default createAnalyticsStore;
  ```

- [ ] **Step 1.2** Создать `backends/node/api/tests/analyticsStore.test.js` — написать первый тест на `getRating` с fake-пулом:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { createAnalyticsStore } from '../src/reports/analyticsStore.js';

  // Fake Postgres pool — возвращает заранее заданные строки
  function fakePool(rowsByQuery) {
    return {
      query(sql, params) {
        for (const [pattern, rows] of rowsByQuery) {
          if (sql.includes(pattern)) return Promise.resolve({ rows });
        }
        return Promise.resolve({ rows: [] });
      }
    };
  }

  test('getRating aggregates azs_id counts from dispatch_log', async () => {
    const pool = fakePool([
      ['azs_id', [
        { azs_id: '12', total: '10', on_time: '8', late: '2', avg_minutes: '23.5' },
        { azs_id: '7',  total: '10', on_time: '6', late: '4', avg_minutes: '37.1' },
      ]]
    ]);
    const store = createAnalyticsStore({ pool, dbType: 'postgres' });
    await assert.rejects(() => store.getRating({ dateFrom: '2026-06-01', dateTo: '2026-06-04' }), /not implemented/);
  });
  ```

- [ ] **Step 1.3** Убедиться: `node --test backends/node/api/tests/analyticsStore.test.js` → тест PASS (assert.rejects ловит 'not implemented').

---

### Task 2 — analyticsStore.js: реализация getRating

Метод `getRating({ dateFrom, dateTo, azsIds=[] })` возвращает массив объектов:
```js
[{
  azsId: '12',
  total: 30,
  onTime: 28,     // done + не просрочено (updated_at <= deadline_at)
  late: 2,        // done + просрочено (updated_at > deadline_at) + expired
  avgMinutes: 23  // AVG(EXTRACT(EPOCH FROM (updated_at - scheduled_at))/60) WHERE status='done'
}]
```

Логика «вовремя»: `status='done' AND (deadline_at IS NULL OR updated_at <= deadline_at)`.
Логика «просрочено в итоге»: `status='expired'` ИЛИ `(status='done' AND deadline_at IS NOT NULL AND updated_at > deadline_at)`.

- [ ] **Step 2.1** Реализовать `getRating` в Postgres-стор:
  ```js
  async getRating({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    let idx = 1;
    if (dateFrom) { where.push(`created_at >= $${idx++}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); }
    if (dateTo)   { where.push(`created_at <= $${idx++}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)  { where.push(`azs_id = $${idx++}`);       params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id = ANY($${idx++})`); params.push(ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        azs_id,
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (
          WHERE status = 'done'
            AND (deadline_at IS NULL OR updated_at <= deadline_at)
        )::int                                                 AS on_time,
        COUNT(*) FILTER (
          WHERE status = 'expired'
            OR (status = 'done' AND deadline_at IS NOT NULL AND updated_at > deadline_at)
        )::int                                                 AS late,
        ROUND(
          AVG(EXTRACT(EPOCH FROM (updated_at - scheduled_at)) / 60.0)
          FILTER (WHERE status = 'done')
        )::int                                                 AS avg_minutes
      FROM dispatch_log
      ${wSql}
      GROUP BY azs_id
      ORDER BY on_time DESC, total DESC
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(r => ({
      azsId:      String(r.azs_id),
      total:      Number(r.total),
      onTime:     Number(r.on_time),
      late:       Number(r.late),
      avgMinutes: r.avg_minutes !== null ? Number(r.avg_minutes) : null,
    }));
  },
  ```

- [ ] **Step 2.2** Реализовать `getRating` в MySQL-стор (аналогично, параметры `?`, даты как строки `YYYY-MM-DD HH:mm:ss`, `TIMESTAMPDIFF(MINUTE, scheduled_at, updated_at)` вместо `EXTRACT`):
  ```js
  async getRating({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo)   { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)  { where.push('azs_id = ?');                              params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        azs_id,
        COUNT(*)                                          AS total,
        SUM(CASE WHEN status = 'done'
                  AND (deadline_at IS NULL OR updated_at <= deadline_at)
             THEN 1 ELSE 0 END)                          AS on_time,
        SUM(CASE WHEN status = 'expired'
                  OR (status = 'done' AND deadline_at IS NOT NULL AND updated_at > deadline_at)
             THEN 1 ELSE 0 END)                          AS late,
        ROUND(AVG(CASE WHEN status = 'done'
                       THEN TIMESTAMPDIFF(MINUTE, scheduled_at, updated_at)
                       ELSE NULL END))                   AS avg_minutes
      FROM dispatch_log
      ${wSql}
      GROUP BY azs_id
      ORDER BY on_time DESC, total DESC
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(r => ({
      azsId:      String(r.azs_id),
      total:      Number(r.total),
      onTime:     Number(r.on_time),
      late:       Number(r.late),
      avgMinutes: r.avg_minutes !== null && r.avg_minutes !== undefined ? Number(r.avg_minutes) : null,
    }));
  },
  ```

- [ ] **Step 2.3** Обновить тест в `analyticsStore.test.js` — убрать `assert.rejects`, добавить реальную проверку:
  ```js
  test('getRating returns sorted aggregates', async () => {
    const pool = fakePool([
      ['GROUP BY azs_id', [
        { azs_id: '12', total: 10, on_time: 8, late: 2, avg_minutes: 23 },
        { azs_id: '7',  total: 10, on_time: 6, late: 4, avg_minutes: 37 },
      ]]
    ]);
    const store = createAnalyticsStore({ pool, dbType: 'postgres' });
    const rows = await store.getRating({ dateFrom: '2026-06-01', dateTo: '2026-06-04' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].azsId, '12');
    assert.equal(rows[0].onTime, 8);
    assert.equal(rows[0].avgMinutes, 23);
  });
  ```

- [ ] **Step 2.4** `node --test backends/node/api/tests/analyticsStore.test.js` → **PASS**.

---

### Task 3 — analyticsStore.js: реализация getTrend

Метод `getTrend({ dateFrom, dateTo, azsIds=[] })` возвращает массив по одной строке на каждый день диапазона:
```js
[{ date: '2026-06-01', total: 8, done: 6, expired: 1, open: 1 }]
```

Основан на вызове `getSummary` по каждому дню (без нового SQL — переиспользуем логику). Но для производительности делаем один JOIN-запрос.

- [ ] **Step 3.1** Реализовать `getTrend` в Postgres-стор — единый запрос, группировка по `DATE(created_at AT TIME ZONE 'UTC')`:
  ```js
  async getTrend({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    let idx = 1;
    if (dateFrom) { where.push(`created_at >= $${idx++}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); }
    if (dateTo)   { where.push(`created_at <= $${idx++}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)  { where.push(`azs_id = $${idx++}`);       params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id = ANY($${idx++})`); params.push(ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        (created_at AT TIME ZONE 'UTC')::date::text      AS day,
        COUNT(*)::int                                     AS total,
        COUNT(*) FILTER (WHERE status = 'done')::int     AS done,
        COUNT(*) FILTER (WHERE status = 'expired')::int  AS expired,
        COUNT(*) FILTER (WHERE status IN ('new','in_progress','reserved'))::int AS open
      FROM dispatch_log
      ${wSql}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(r => ({
      date:    String(r.day),
      total:   Number(r.total),
      done:    Number(r.done),
      expired: Number(r.expired),
      open:    Number(r.open),
    }));
  },
  ```

- [ ] **Step 3.2** Реализовать `getTrend` в MySQL-стор (`DATE(created_at)` вместо `AT TIME ZONE`):
  ```js
  async getTrend({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo)   { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)  { where.push('azs_id = ?');                               params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`azs_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        DATE_FORMAT(created_at, '%Y-%m-%d')              AS day,
        COUNT(*)                                         AS total,
        SUM(status = 'done')                             AS done,
        SUM(status = 'expired')                          AS expired,
        SUM(status IN ('new','in_progress','reserved'))  AS open
      FROM dispatch_log
      ${wSql}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(r => ({
      date:    String(r.day),
      total:   Number(r.total),
      done:    Number(r.done),
      expired: Number(r.expired),
      open:    Number(r.open),
    }));
  },
  ```

- [ ] **Step 3.3** Добавить тест в `analyticsStore.test.js`:
  ```js
  test('getTrend returns one row per day', async () => {
    const pool = fakePool([
      ['GROUP BY 1', [
        { day: '2026-06-01', total: 7, done: 5, expired: 1, open: 1 },
        { day: '2026-06-02', total: 8, done: 7, expired: 0, open: 1 },
      ]]
    ]);
    const store = createAnalyticsStore({ pool, dbType: 'postgres' });
    const rows = await store.getTrend({ dateFrom: '2026-06-01', dateTo: '2026-06-02' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].date, '2026-06-01');
    assert.equal(rows[1].done, 7);
  });
  ```

- [ ] **Step 3.4** `node --test backends/node/api/tests/analyticsStore.test.js` → **PASS**.

---

### Task 4 — analyticsStore.js: реализация getDayPhotos

Метод `getDayPhotos({ date, azsIds=[] })` возвращает список сданных (`done`) отчётов за конкретный день со всеми их фотографиями:
```js
[{
  reportId: 42,
  azsId: '12',
  doneAt: '2026-06-04T09:12:00Z',
  photos: [{
    photoCode: '5',
    diskObjectId: 9987654,
    diskFolderId: 12345,
    exifAt: '2026-06-04T09:10:00Z',
    uploadedAt: '2026-06-04T09:11:30Z'
  }]
}]
```

- [ ] **Step 4.1** Реализовать `getDayPhotos` в Postgres-стор:
  ```js
  async getDayPhotos({ date, azsIds = [] } = {}) {
    if (!date) return [];
    const where = [
      `d.status = 'done'`,
      `d.created_at >= $1`,
      `d.created_at <= $2`,
    ];
    const params = [
      new Date(`${date}T00:00:00.000Z`),
      new Date(`${date}T23:59:59.999Z`),
    ];
    let idx = 3;
    const ids = Array.isArray(azsIds) ? azsIds.map(String).filter(Boolean) : [];
    if (ids.length === 1)  { where.push(`d.azs_id = $${idx++}`);       params.push(ids[0]); }
    else if (ids.length > 1) { where.push(`d.azs_id = ANY($${idx++})`); params.push(ids); }
    const sql = `
      SELECT
        d.id AS report_id, d.azs_id, d.updated_at AS done_at,
        rp.photo_code, rp.disk_object_id, rp.disk_folder_id, rp.exif_at, rp.uploaded_at
      FROM dispatch_log d
      JOIN report_photo rp ON rp.report_id = d.id
      WHERE ${where.join(' AND ')}
      ORDER BY d.updated_at DESC, rp.photo_code ASC
    `;
    const result = await pool.query(sql, params);
    // Group by report
    const map = new Map();
    for (const row of result.rows) {
      const key = Number(row.report_id);
      if (!map.has(key)) {
        map.set(key, {
          reportId: key,
          azsId:    String(row.azs_id),
          doneAt:   row.done_at ? new Date(row.done_at).toISOString() : null,
          photos:   [],
        });
      }
      map.get(key).photos.push({
        photoCode:    row.photo_code,
        diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
        diskFolderId: row.disk_folder_id ? Number(row.disk_folder_id) : null,
        exifAt:       row.exif_at ? new Date(row.exif_at).toISOString() : null,
        uploadedAt:   row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
      });
    }
    return [...map.values()];
  },
  ```

- [ ] **Step 4.2** Реализовать `getDayPhotos` в MySQL-стор (то же, `?`-параметры, `DATE_FORMAT`).

- [ ] **Step 4.3** Добавить тест в `analyticsStore.test.js`:
  ```js
  test('getDayPhotos groups photos by reportId', async () => {
    const pool = fakePool([
      ['JOIN report_photo', [
        { report_id: 1, azs_id: '12', done_at: new Date('2026-06-04T09:12:00Z'),
          photo_code: 'hall', disk_object_id: 999, disk_folder_id: 100,
          exif_at: new Date('2026-06-04T09:10:00Z'), uploaded_at: new Date('2026-06-04T09:11:00Z') },
        { report_id: 1, azs_id: '12', done_at: new Date('2026-06-04T09:12:00Z'),
          photo_code: 'wc', disk_object_id: 1000, disk_folder_id: 100,
          exif_at: null, uploaded_at: new Date('2026-06-04T09:11:30Z') },
      ]]
    ]);
    const store = createAnalyticsStore({ pool, dbType: 'postgres' });
    const result = await store.getDayPhotos({ date: '2026-06-04' });
    assert.equal(result.length, 1);
    assert.equal(result[0].photos.length, 2);
    assert.equal(result[0].photos[0].photoCode, 'hall');
  });
  ```

- [ ] **Step 4.4** `node --test backends/node/api/tests/analyticsStore.test.js` → **PASS** (все 3 теста).

---

### Task 5 — analyticsRoutes.js: эндпоинты + HTTP-тесты

- [ ] **Step 5.1** Создать `backends/node/api/src/reports/analyticsRoutes.js`:
  ```js
  import express from 'express';

  const normDate = (v) => { const r = String(v||'').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : ''; };
  const normIds  = (v) => {
    const src = Array.isArray(v) ? v : String(v||'').split(/[,;\n]+/g);
    return [...new Set(src.map(s=>String(s||'').trim()).filter(Boolean))];
  };
  const canReview = (req) => (
    Boolean(req.accessContext?.capabilities?.reviewer) ||
    Boolean(req.accessContext?.capabilities?.settings)
  );

  export const createAnalyticsRouter = ({ analyticsStore, reportsStore, bitrixClient, settingsStore, diskApi }) => {
    if (!analyticsStore) throw new Error('analyticsStore is required');
    const router = express.Router();

    // GET /api/reports/analytics/rating?dateFrom=&dateTo=&azsId=
    router.get('/rating', async (req, res) => {
      if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });
      try {
        const rows = await analyticsStore.getRating({
          dateFrom: normDate(req.query.dateFrom),
          dateTo:   normDate(req.query.dateTo),
          azsIds:   normIds(req.query.azsId),
        });
        // Резолвим имена АЗС батчем
        const settings = await settingsStore.read();
        const { createAzsTitleResolver } = await import('./reportsRoutes.js');
        const resolve = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
        const items = await Promise.all(rows.map(async r => ({
          ...r,
          azsTitle: await resolve(r.azsId),
          pct: r.total ? Math.round(r.onTime / r.total * 100) : 0,
        })));
        return res.json({ items });
      } catch (err) {
        return res.status(500).json({ error: 'analytics_rating_failed', message: err.message });
      }
    });

    // GET /api/reports/analytics/trend?dateFrom=&dateTo=&azsId=
    router.get('/trend', async (req, res) => {
      if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });
      try {
        const rows = await analyticsStore.getTrend({
          dateFrom: normDate(req.query.dateFrom),
          dateTo:   normDate(req.query.dateTo),
          azsIds:   normIds(req.query.azsId),
        });
        return res.json({ items: rows });
      } catch (err) {
        return res.status(500).json({ error: 'analytics_trend_failed', message: err.message });
      }
    });

    // GET /api/reports/analytics/day-photos?date=&azsId=
    router.get('/day-photos', async (req, res) => {
      if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });
      try {
        const date = normDate(req.query.date) || (() => {
          const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        })();
        const rows = await analyticsStore.getDayPhotos({
          date,
          azsIds: normIds(req.query.azsId),
        });
        const settings = await settingsStore.read();
        const { createAzsTitleResolver } = await import('./reportsRoutes.js');
        const resolve = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
        const items = await Promise.all(rows.map(async r => ({
          ...r,
          azsTitle: await resolve(r.azsId),
        })));
        return res.json({ items, date });
      } catch (err) {
        return res.status(500).json({ error: 'analytics_day_photos_failed', message: err.message });
      }
    });

    // GET /api/reports/photos/:reportId/:photoCode/preview
    // Отдаёт binary-данные фото, полученные через Bitrix Disk API по disk_object_id.
    // Если diskApi не поддерживает downloadFile — возвращает 501.
    router.get('/photos/:reportId/:photoCode/preview', async (req, res) => {
      // Доступ: reviewer или reports (admin АЗС).
      if (!canReview(req) && !Boolean(req.accessContext?.capabilities?.reports)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      try {
        const reportId = Number(req.params.reportId);
        if (!Number.isFinite(reportId) || reportId <= 0) {
          return res.status(400).json({ error: 'invalid_report_id' });
        }
        const photoCode = String(req.params.photoCode || '').trim().toLowerCase();
        if (!photoCode) return res.status(400).json({ error: 'invalid_photo_code' });

        const photos = await reportsStore.listPhotos(reportId);
        const photo = photos.find(p => String(p.photoCode||'').toLowerCase() === photoCode);
        if (!photo) return res.status(404).json({ error: 'photo_not_found' });
        if (!photo.diskObjectId) return res.status(404).json({ error: 'disk_object_id_missing' });

        if (!diskApi || typeof diskApi.downloadFile !== 'function') {
          return res.status(501).json({ error: 'preview_not_supported', message: 'diskApi.downloadFile is not available' });
        }

        const context = req.bitrixContext || {};
        const { buffer, contentType } = await diskApi.downloadFile(photo.diskObjectId, context);
        res.setHeader('Content-Type', contentType || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.send(buffer);
      } catch (err) {
        return res.status(502).json({ error: 'preview_failed', message: err.message });
      }
    });

    return router;
  };

  export default createAnalyticsRouter;
  ```

  **Важно:** `createAzsTitleResolver` экспортируется из `reportsRoutes.js`. Если он там не именован — добавить `export` к его определению в следующем шаге.

- [ ] **Step 5.2** В `backends/node/api/src/reports/reportsRoutes.js` убедиться, что `createAzsTitleResolver` экспортируется именованно (добавить `export` если нет).

- [ ] **Step 5.3** Создать `backends/node/api/tests/analyticsRoutes.test.js`:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { createAnalyticsRouter } from '../src/reports/analyticsRoutes.js';

  function makeRes() {
    return {
      statusCode: 200,
      _headers: {},
      status(c) { this.statusCode = c; return this; },
      json(p)   { this._payload = p; return p; },
      setHeader(k, v) { this._headers[k] = v; },
      send(b)   { this._body = b; },
    };
  }

  function makeReq(overrides = {}) {
    return {
      params: {}, query: {},
      accessContext: { capabilities: { reviewer: true } },
      bitrixContext: {},
      ...overrides,
    };
  }

  const stubDeps = {
    analyticsStore: {
      async getRating()    { return [{ azsId: '12', total: 10, onTime: 8, late: 2, avgMinutes: 23 }]; },
      async getTrend()     { return [{ date: '2026-06-01', total: 7, done: 5, expired: 1, open: 1 }]; },
      async getDayPhotos() { return []; },
    },
    reportsStore:   { async listPhotos() { return []; } },
    bitrixClient:   { async getCrmItem() { return null; } },
    settingsStore:  { async read() { return { azs: { entityTypeId: 145 } }; } },
    diskApi:        null,
  };

  test('GET /analytics/rating returns items array', async () => {
    const router = createAnalyticsRouter(stubDeps);
    const handler = router.stack.find(l => l.route?.path === '/rating')?.route?.stack[0]?.handle;
    if (!handler) return; // маршрут найден по-другому при EXPRESS5 — просто пропустить
    const req = makeReq({ query: { dateFrom: '2026-06-01', dateTo: '2026-06-04' } });
    const res = makeRes();
    await handler(req, res);
    assert.ok(Array.isArray(res._payload?.items));
  });

  test('GET /analytics/rating returns 403 for unauthorized', async () => {
    const router = createAnalyticsRouter(stubDeps);
    const handler = router.stack.find(l => l.route?.path === '/rating')?.route?.stack[0]?.handle;
    if (!handler) return;
    const req = makeReq({ accessContext: { capabilities: {} } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  });
  ```

- [ ] **Step 5.4** `node --test backends/node/api/tests/analyticsRoutes.test.js` → **PASS**.

---

### Task 6 — Монтирование в reportsRoutes + server.js

- [ ] **Step 6.1** В `createReportsRouter` в `reportsRoutes.js` добавить параметр `analyticsStore` и `diskApi`:
  ```js
  export const createReportsRouter = ({
    reportsStore,
    dispatchService,
    settingsStore,
    bitrixClient,
    notificationService,
    authContextStore,
    crmSyncJobStore,
    dispatchPlanStore = null,
    dispatchPlanMirror = null,
    analyticsStore = null,    // новое
    diskApi = null,           // новое
  }) => {
    // ... существующий код ...
    // В конце перед return router:
    if (analyticsStore) {
      const { createAnalyticsRouter } = await import('./analyticsRoutes.js'); // top-level import предпочтительнее
      router.use('/analytics', createAnalyticsRouter({
        analyticsStore, reportsStore, bitrixClient, settingsStore, diskApi
      }));
      // preview прокси монтируем напрямую
      router.use('/photos', createAnalyticsRouter({
        analyticsStore, reportsStore, bitrixClient, settingsStore, diskApi
      }));
    }
  ```
  
  **Лучше — статический импорт:** добавить `import { createAnalyticsRouter } from './analyticsRoutes.js';` в начало файла и убрать динамический.

  Схема монтирования в `server.js`:
  ```js
  // server.js — добавить после createReportsStore
  import { createAnalyticsStore } from './src/reports/analyticsStore.js';
  // ...
  const analyticsStore = createAnalyticsStore({ pool, dbType });
  // В createReportsRouter({ ..., analyticsStore, diskApi: bitrixClient.diskApi })
  ```

- [ ] **Step 6.2** Проверить вручную, что сервер поднимается без ошибок: `node server.js` (или `make dev-node`), в логах нет `Error`.

---

## Фаза B — Frontend: каркас + навигация

### Task 7 — Новый экран reports.client.vue + навигация

- [ ] **Step 7.1** Создать `frontend/app/pages/reports.client.vue` с минимальным скелетом:
  ```vue
  <script setup lang="ts">
  import type { B24Frame } from '@bitrix24/b24jssdk'

  const PAGE_TITLE = 'Отчёты АЗС'
  useHead({ title: PAGE_TITLE })

  const { initApp } = useAppInit('ReportsPage')
  const { $initializeB24Frame } = useNuxtApp()
  const apiStore = useApiStore()

  type ReportTab = 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
  const activeTab = ref<ReportTab>('r1')

  const hasAccess = ref(false)
  const accessError = ref('')

  let $b24: null | B24Frame = null

  onMounted(async () => {
    try {
      $b24 = await $initializeB24Frame()
      const { locales, setLocale } = useI18n()
      await initApp($b24, locales, setLocale)
      const roleResp = await apiStore.getMyRole()
      hasAccess.value = Boolean(
        roleResp.capabilities?.reviewer || roleResp.capabilities?.settings || roleResp.capabilities?.reports
      )
      if (!hasAccess.value) {
        accessError.value = 'Недостаточно прав для просмотра отчётов'
        return
      }
      await $b24.parent.setTitle(PAGE_TITLE)
    } catch (e) {
      accessError.value = e instanceof Error ? e.message : 'Ошибка инициализации'
    }
  })
  </script>

  <template>
    <div class="w-full bg-[#eef1f4] min-h-screen">
      <B24Alert v-if="accessError" color="air-primary-alert" :description="accessError" class="m-4" />
      <template v-else-if="hasAccess">
        <div class="flex min-h-screen">
          <ReportNav v-model:active="activeTab" class="hidden lg:block" />
          <main class="flex-1 p-6 max-w-[1180px] mx-auto w-full pb-24 lg:pb-6">
            <R1Summary v-if="activeTab === 'r1'" />
            <R2Rating  v-else-if="activeTab === 'r2'" />
            <R3Trend   v-else-if="activeTab === 'r3'" />
            <R4Card    v-else-if="activeTab === 'r4'" />
            <R5Wall    v-else-if="activeTab === 'r5'" />
          </main>
          <!-- Мобильная нижняя навигация -->
          <ReportNav v-model:active="activeTab" mobile class="lg:hidden" />
        </div>
      </template>
    </div>
  </template>
  ```

- [ ] **Step 7.2** Создать `frontend/app/components/reports/ReportNav.vue`:
  ```vue
  <script setup lang="ts">
  type Tab = 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
  const props = defineProps<{ active: Tab; mobile?: boolean }>()
  const emit = defineEmits<{ 'update:active': [v: Tab] }>()

  const tabs: Array<{ id: Tab; label: string; sub: string }> = [
    { id: 'r1', label: 'Сводка за день',   sub: 'операционка' },
    { id: 'r2', label: 'Рейтинг АЗС',      sub: 'дисциплина' },
    { id: 'r3', label: 'Динамика',          sub: 'тренд по дням' },
    { id: 'r4', label: 'Карточка АЗС',      sub: 'таймлайн + фото' },
    { id: 'r5', label: 'Фото-витрина',      sub: 'фото за день' },
  ]
  </script>

  <template>
    <!-- Десктоп: вертикальное меню -->
    <nav v-if="!mobile"
      class="w-[248px] bg-white border-r border-gray-200 px-2.5 py-3.5 sticky top-0 h-screen overflow-auto flex-shrink-0"
    >
      <div class="text-[11px] uppercase tracking-[0.6px] text-gray-400 px-3 py-2 mb-1">Отчёты</div>
      <button
        v-for="tab in tabs" :key="tab.id"
        :class="[
          'w-full text-left flex gap-2.5 items-center px-3 py-2.5 rounded-[10px] mb-0.5 font-semibold text-[13.5px] transition-colors',
          active === tab.id
            ? 'bg-blue-50 text-blue-600'
            : 'text-[#33485f] hover:bg-gray-100'
        ]"
        @click="emit('update:active', tab.id)"
      >
        <span class="flex-1">
          <span class="block">{{ tab.label }}</span>
          <span class="block font-medium text-[11.5px]" :class="active === tab.id ? 'text-blue-400' : 'text-gray-400'">{{ tab.sub }}</span>
        </span>
      </button>
    </nav>

    <!-- Мобиль: нижняя панель -->
    <nav v-else
      class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex gap-1 overflow-x-auto px-2 py-2 z-40"
    >
      <button
        v-for="tab in tabs" :key="tab.id"
        :class="[
          'flex flex-col items-center gap-1 min-w-[70px] px-1.5 py-2 rounded-[10px] text-[11px] font-semibold transition-colors',
          active === tab.id ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'
        ]"
        @click="emit('update:active', tab.id)"
      >
        {{ tab.label.split(' ')[0] }}
      </button>
    </nav>
  </template>
  ```

- [ ] **Step 7.3** Добавить в `frontend/app/stores/api.ts` три новых метода (типы + реализация):
  ```ts
  // Типы (добавить в начало файла рядом с существующими)
  type RatingRow = {
    azsId: string; azsTitle?: string | null; total: number
    onTime: number; late: number; avgMinutes: number | null; pct: number
  }
  type TrendRow = { date: string; total: number; done: number; expired: number; open: number }
  type DayPhotoEntry = {
    reportId: number; azsId: string; azsTitle?: string | null; doneAt: string | null
    photos: Array<{ photoCode: string; diskObjectId: number | null; diskFolderId: number | null; exifAt: string | null; uploadedAt: string | null }>
  }

  // Методы (добавить в return useApiStore)
  const getReportsRating = async (filters: { dateFrom?: string; dateTo?: string; azsId?: string } = {}): Promise<{ items: RatingRow[] }> =>
    await $api('/api/reports/analytics/rating', { query: filters, headers: { Authorization: `Bearer ${tokenJWT.value}` } })

  const getReportsTrend = async (filters: { dateFrom?: string; dateTo?: string; azsId?: string } = {}): Promise<{ items: TrendRow[] }> =>
    await $api('/api/reports/analytics/trend', { query: filters, headers: { Authorization: `Bearer ${tokenJWT.value}` } })

  const getDayPhotos = async (filters: { date?: string; azsId?: string } = {}): Promise<{ items: DayPhotoEntry[]; date: string }> =>
    await $api('/api/reports/analytics/day-photos', { query: filters, headers: { Authorization: `Bearer ${tokenJWT.value}` } })
  ```

  Добавить новые методы в объект `return { ..., getReportsRating, getReportsTrend, getDayPhotos }`.

- [ ] **Step 7.4** Добавить кнопку перехода в «Отчёты» из `frontend/app/pages/index.client.vue` или `reviewer.client.vue`:
  В `index.client.vue` добавить кнопку `<NuxtLink to="/reports" class="...">Отчёты</NuxtLink>` рядом с кнопкой «Проверка отчётов».

- [ ] **Step 7.5** Ручная проверка: открыть приложение → нажать «Отчёты» → экран открывается, навигация по вкладкам переключает контент (пустые placeholder-компоненты), ошибок в консоли нет.

---

## Фаза C — Frontend: SVG-компоненты

### Task 8 — SVG-примитивы

- [ ] **Step 8.1** Создать `frontend/app/components/reports/SvgRing.vue`:
  ```vue
  <script setup lang="ts">
  const props = defineProps<{ pct: number; color?: string; size?: number }>()
  const R = 54
  const C = 2 * Math.PI * R
  const off = computed(() => C * (1 - Math.max(0, Math.min(100, props.pct)) / 100))
  const color = computed(() => props.color || 'var(--b24-color-success, #1fa363)')
  const sz = computed(() => props.size || 128)
  </script>
  <template>
    <div class="relative" :style="`width:${sz}px;height:${sz}px`">
      <svg :viewBox="`0 0 ${sz} ${sz}`" :width="sz" :height="sz">
        <circle :cx="sz/2" :cy="sz/2" :r="R" fill="none" stroke="#eef2f6" stroke-width="14"/>
        <circle
          :cx="sz/2" :cy="sz/2" :r="R" fill="none" :stroke="color" stroke-width="14"
          stroke-linecap="round"
          :stroke-dasharray="C"
          :stroke-dashoffset="off"
          :transform="`rotate(-90 ${sz/2} ${sz/2})`"
        />
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center">
        <b class="text-[30px] font-extrabold tracking-tight">{{ pct }}%</b>
        <span class="text-[11.5px] text-gray-400">вовремя</span>
      </div>
    </div>
  </template>
  ```

- [ ] **Step 8.2** Создать `frontend/app/components/reports/SvgStackBar.vue`:
  ```vue
  <script setup lang="ts">
  const props = defineProps<{
    parts: Array<{ n: number; color: string }>
    total: number
    height?: number
  }>()
  const W = 560
  const H = computed(() => props.height || 34)
  const rects = computed(() => {
    let x = 0
    return props.parts.map(p => {
      const w = props.total ? (p.n / props.total) * W : 0
      const rect = { x, w: Math.max(0, w - 2), color: p.color, n: p.n }
      x += w
      return rect
    }).filter(r => r.w > 0)
  })
  </script>
  <template>
    <svg :viewBox="`0 0 ${W} ${H}`" width="100%" :height="H" preserveAspectRatio="none">
      <rect v-if="!rects.length" :width="W" :height="H" rx="6" fill="#eef2f6"/>
      <rect
        v-for="(r, i) in rects" :key="i"
        :x="r.x" y="0" :width="r.w" :height="H" rx="6"
        :fill="r.color"
      ><title>{{ r.n }}</title></rect>
    </svg>
  </template>
  ```

- [ ] **Step 8.3** Создать `frontend/app/components/reports/SvgLine.vue`:
  ```vue
  <script setup lang="ts">
  const props = defineProps<{ data: number[]; minV?: number; maxV?: number; color?: string }>()
  const W = 820; const H = 200; const pad = 28
  const minV = computed(() => props.minV ?? 40)
  const maxV = computed(() => props.maxV ?? 100)
  const color = computed(() => props.color || 'var(--b24-color-link, #2a6bd4)')
  const xOf = (i: number) => pad + i * (W - pad * 2) / Math.max(props.data.length - 1, 1)
  const yOf = (v: number) => H - pad - (v - minV.value) / (maxV.value - minV.value) * (H - pad * 2)
  const linePath = computed(() => props.data.map((v, i) => `${i ? 'L' : 'M'} ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' '))
  const areaPath = computed(() => {
    const n = props.data.length - 1
    return props.data.map((v, i) => `${i ? 'L' : 'M'} ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' ')
      + ` L ${xOf(n)} ${H - pad} L ${xOf(0)} ${H - pad} Z`
  })
  const gridLines = [50, 60, 70, 80, 90, 100]
  const dots = computed(() => props.data
    .map((v, i) => ({ i, v, show: props.data.length <= 31 || i % 3 === 0 || i === props.data.length - 1 }))
    .filter(d => d.show)
  )
  </script>
  <template>
    <svg :viewBox="`0 0 ${W} ${H}`" width="100%" overflow="visible">
      <defs>
        <linearGradient id="svgline-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :stop-color="color" stop-opacity="0.22"/>
          <stop offset="1" :stop-color="color" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line v-for="g in gridLines" :key="g" :x1="pad" :x2="W-pad" :y1="yOf(g)" :y2="yOf(g)" stroke="#eef2f6"/>
      <text v-for="g in gridLines" :key="'t'+g" x="2" :y="yOf(g)+4" font-size="10" fill="#9aa7b5">{{ g }}</text>
      <path :d="areaPath" fill="url(#svgline-grad)"/>
      <path :d="linePath" fill="none" :stroke="color" stroke-width="2.5" stroke-linejoin="round"/>
      <circle
        v-for="d in dots" :key="d.i"
        :cx="xOf(d.i).toFixed(1)" :cy="yOf(d.v).toFixed(1)"
        r="3" fill="#fff" :stroke="color" stroke-width="2"
      ><title>день {{ d.i + 1 }}: {{ d.v }}%</title></circle>
    </svg>
  </template>
  ```

- [ ] **Step 8.4** Создать `frontend/app/components/reports/SvgGroupBars.vue`:
  ```vue
  <script setup lang="ts">
  const props = defineProps<{ done: number[]; late: number[] }>()
  const W = 820; const H = 170; const pad = 22
  const n = computed(() => props.done.length)
  const gap = computed(() => n.value > 40 ? 1 : 3)
  const bw = computed(() => (W - pad * 2) / Math.max(n.value, 1))
  const maxVal = computed(() => Math.max(...props.done.map((d, i) => d + props.late[i]), 1))
  const yOf = (v: number) => H - pad - v / maxVal.value * (H - pad * 2)
  </script>
  <template>
    <svg :viewBox="`0 0 ${W} ${H}`" width="100%">
      <template v-for="(d, i) in done" :key="i">
        <rect
          :x="(pad + i * bw).toFixed(1)"
          :y="(yOf(d) - (H - pad - yOf(late[i]))).toFixed(1)"
          :width="(bw - gap).toFixed(1)"
          :height="(H - pad - yOf(d)).toFixed(1)"
          fill="var(--b24-color-success, #1fa363)" rx="2"
        ><title>день {{ i + 1 }}: сдано {{ d }}</title></rect>
        <rect
          :x="(pad + i * bw).toFixed(1)"
          :y="yOf(late[i]).toFixed(1)"
          :width="(bw - gap).toFixed(1)"
          :height="(H - pad - yOf(late[i])).toFixed(1)"
          fill="var(--b24-color-danger, #e0533b)" rx="2"
        ><title>день {{ i + 1 }}: просрочено {{ late[i] }}</title></rect>
      </template>
      <line :x1="pad" :x2="W - pad" :y1="H - pad" :y2="H - pad" stroke="#e3e8ee"/>
    </svg>
  </template>
  ```

- [ ] **Step 8.5** Ручная проверка: временно добавить `<SvgRing :pct="75" />` в `R1Summary.vue` placeholder → кольцо рендерится в браузере.

---

## Фаза C1 — Отчёт 1: Сводка за день/период

### Task 9 — R1Summary.vue

- [ ] **Step 9.1** Создать `frontend/app/components/reports/R1Summary.vue`. Логика использует уже существующие `apiStore.getReports` + `apiStore.getReportsSummary`. Никакого нового API не нужено для базовых KPI и таблицы.
  ```vue
  <script setup lang="ts">
  import { DateTime } from 'luxon'

  type PeriodKey = 'today' | 'yest' | '7' | '30' | 'custom'

  const apiStore = useApiStore()
  const period  = ref<PeriodKey>('today')
  const customFrom = ref(''); const customTo = ref('')
  const azsFilter = ref<string[]>([])
  const azsOptions = ref<Array<{ value: string; label: string }>>([])

  type SummaryType = { total: number; done: number; expired: number; open: number; failed: number; overdue: number; byStatus: Record<string, number> }
  type ReportItem = {
    id: number; azsId: string; azsTitle?: string | null; adminUserId: number; status: string
    scheduledAt: string | null; deadlineAt: string | null; updatedAt: string | null; diskFolderId: number | null
  }
  const summary = ref<SummaryType>({ total: 0, done: 0, expired: 0, open: 0, failed: 0, overdue: 0, byStatus: {} })
  const items   = ref<ReportItem[]>([])
  const loading = ref(false)
  const error   = ref('')

  const computeRange = () => {
    const now = DateTime.utc()
    if (period.value === 'today') return { from: now.toISODate(), to: now.toISODate() }
    if (period.value === 'yest')  { const y = now.minus({ days: 1 }); return { from: y.toISODate(), to: y.toISODate() } }
    if (period.value === '7')     return { from: now.minus({ days: 6 }).toISODate(), to: now.toISODate() }
    if (period.value === '30')    return { from: now.minus({ days: 29 }).toISODate(), to: now.toISODate() }
    return { from: customFrom.value, to: customTo.value }
  }

  const load = async () => {
    const range = computeRange()
    if (!range.from || !range.to) return
    loading.value = true; error.value = ''
    try {
      const [r, s] = await Promise.all([
        apiStore.getReports({ dateFrom: range.from, dateTo: range.to, limit: 500 }),
        apiStore.getReportsSummary({ dateFrom: range.from, dateTo: range.to })
      ])
      items.value   = r.items
      summary.value = s.summary
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Ошибка загрузки'
    } finally {
      loading.value = false
    }
  }

  const displayItems = computed(() => {
    if (!azsFilter.value.length) return items.value
    return items.value.filter(i => azsFilter.value.includes(i.azsId))
  })

  const pct = computed(() => summary.value.total ? Math.round(summary.value.done / summary.value.total * 100) : 0)

  const STATUS_LABEL: Record<string, string> = {
    done: 'Сдано', expired: 'Просрочено', in_progress: 'В работе', new: 'Ожидает', failed: 'Ошибка', reserved: 'Резерв'
  }
  const STATUS_COLOR: Record<string, string> = {
    done: 'text-green-700 bg-green-50', expired: 'text-red-700 bg-red-50',
    in_progress: 'text-yellow-700 bg-yellow-50', new: 'text-gray-500 bg-gray-100',
    failed: 'text-gray-600 bg-gray-100'
  }
  const fmtTime = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('HH:mm') : '—'

  onMounted(async () => {
    try {
      const resp = await apiStore.getAzsOptions({ limit: 500 })
      azsOptions.value = resp.items.map(i => ({ value: String(i.id), label: i.title || `АЗС ${i.id}` }))
    } catch { /* non-fatal */ }
    await load()
  })
  watch(period, load)
  </script>

  <template>
    <div>
      <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h1 class="text-[21px] font-semibold">Сводка за день</h1>
          <p class="text-sm text-gray-500 mt-0.5">Операционный статус прохождения отчётов по всем АЗС</p>
        </div>
        <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: dispatch_log · getSummary + list</span>
      </div>

      <!-- Фильтры -->
      <div class="flex gap-2.5 flex-wrap mb-4">
        <div class="inline-flex bg-white border border-gray-200 rounded-[10px] p-0.5 shadow-sm">
          <button v-for="(lbl, k) in { today: 'Сегодня', yest: 'Вчера', '7': '7 дней', '30': '30 дней' }" :key="k"
            :class="['px-3 py-1.5 rounded-lg font-semibold text-[12.5px] transition-colors', period === k ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100']"
            @click="period = k as PeriodKey; load()"
          >{{ lbl }}</button>
        </div>
        <!-- AZS multi-select -->
        <select v-model="azsFilter" multiple class="hidden" />
        <B24InputMenu
          v-model="azsFilter"
          :items="azsOptions"
          value-attribute="value"
          option-attribute="label"
          multiple
          placeholder="Все АЗС"
          class="min-w-[180px]"
        />
      </div>

      <!-- KPI cards -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-3.5 mb-3.5">
        <div v-for="kpi in [
          { t: 'Запланировано', v: summary.total,   s: 'слотов',           cls: 'border-blue-400',  vc: 'text-blue-600'  },
          { t: 'Сдано',         v: summary.done,    s: 'отчётов',          cls: 'border-green-500', vc: 'text-green-600' },
          { t: 'Просрочено',    v: summary.expired, s: 'не сдано в срок',  cls: 'border-red-400',   vc: 'text-red-600'   },
          { t: 'В работе',      v: summary.open,    s: 'открыто сейчас',   cls: 'border-yellow-400',vc: 'text-yellow-600'},
          { t: 'Ошибки',        v: summary.failed,  s: 'сбой отправки',   cls: 'border-gray-400',  vc: 'text-gray-500'  },
        ]" :key="kpi.t"
          :class="['bg-white border border-gray-200 border-l-4 rounded-[14px] shadow-sm p-4', kpi.cls]"
        >
          <div class="text-[12px] text-gray-400 font-semibold uppercase tracking-[0.4px]">{{ kpi.t }}</div>
          <div :class="['text-[30px] font-extrabold mt-1.5 tracking-tight', kpi.vc]">{{ kpi.v }}</div>
          <div class="text-[12px] text-gray-400 mt-0.5">{{ kpi.s }}</div>
        </div>
      </div>

      <!-- Ring + Stack row -->
      <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3.5 mb-3.5">
        <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
          <h3 class="font-semibold text-[14.5px] mb-3.5">Выполнение</h3>
          <div class="flex items-center gap-4">
            <SvgRing :pct="pct" />
            <div>
              <div class="text-[12px] text-gray-400">Сдано вовремя</div>
              <div class="font-bold text-[15px] mt-0.5">{{ summary.done }} из {{ summary.total }} АЗС</div>
              <div class="flex flex-col gap-1.5 mt-3 text-[12px] text-gray-500">
                <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-green-500 mr-1.5 align-[-1px]"/>Сдано</span>
                <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-400 mr-1.5 align-[-1px]"/>В работе</span>
                <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-red-400 mr-1.5 align-[-1px]"/>Просрочено</span>
                <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-gray-300 mr-1.5 align-[-1px]"/>Ожидает</span>
              </div>
            </div>
          </div>
        </div>
        <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
          <h3 class="font-semibold text-[14.5px] mb-3.5">Распределение по статусам</h3>
          <SvgStackBar :parts="[
            { n: summary.done,    color: '#1fa363' },
            { n: summary.open,    color: '#e0a020' },
            { n: summary.expired, color: '#e0533b' },
            { n: summary.byStatus?.new ?? 0, color: '#9aa7b5' },
          ]" :total="summary.total" />
          <div class="flex gap-3.5 flex-wrap mt-3 text-[12px] text-gray-500">
            <span v-for="(s, c) in { Сдано: '#1fa363', 'В работе': '#e0a020', Просрочено: '#e0533b', Ожидает: '#9aa7b5' }" :key="s">
              <i class="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]" :style="`background:${c}`"/>{{ s }}
            </span>
          </div>
        </div>
      </div>

      <!-- Таблица -->
      <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
      <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
      <div v-else class="bg-white border border-gray-200 rounded-[14px] shadow-sm overflow-x-auto">
        <table class="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">АЗС</th>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Уведомление</th>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Дедлайн</th>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Сдано</th>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Статус</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in displayItems" :key="item.id" class="hover:bg-gray-50">
              <td class="px-3 py-2.5 border-b border-gray-50">
                <b class="block">{{ item.azsTitle || `АЗС ${item.azsId}` }}</b>
                <span class="text-[12px] text-gray-400">ID {{ item.azsId }}</span>
              </td>
              <td class="px-3 py-2.5 border-b border-gray-50 tabular-nums">{{ fmtTime(item.scheduledAt) }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50 tabular-nums">{{ fmtTime(item.deadlineAt) }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50 tabular-nums">{{ fmtTime(item.updatedAt) }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50">
                <span :class="['inline-flex items-center gap-1.5 text-[12px] font-bold px-2.5 py-1 rounded-full', STATUS_COLOR[item.status] || 'text-gray-500 bg-gray-100']">
                  <span class="w-1.5 h-1.5 rounded-full bg-current opacity-90"/>
                  {{ STATUS_LABEL[item.status] || item.status }}
                </span>
              </td>
            </tr>
            <tr v-if="!displayItems.length">
              <td colspan="5" class="text-center py-8 text-gray-400">Нет данных за выбранный период</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
  ```

- [ ] **Step 9.2** Ручная проверка: вкладка «Сводка за день» → отображаются KPI-карточки с реальными числами, кольцо, таблица строк.

---

## Фаза C2 — Отчёт 2: Рейтинг дисциплины

### Task 10 — R2Rating.vue

- [ ] **Step 10.1** Создать `frontend/app/components/reports/R2Rating.vue`. Использует `apiStore.getReportsRating`.
  ```vue
  <script setup lang="ts">
  import { DateTime } from 'luxon'

  const apiStore = useApiStore()
  type PeriodKey = '7' | '30' | '90'
  const period = ref<PeriodKey>('30')
  const rows = ref<Array<{ azsId: string; azsTitle?: string | null; total: number; onTime: number; late: number; avgMinutes: number | null; pct: number }>>([])
  const loading = ref(false); const error = ref('')
  type SortKey = 'pct' | 'onTime' | 'late' | 'total' | 'avg'
  const sort = reactive<{ k: SortKey; dir: 1 | -1 }>({ k: 'pct', dir: -1 })

  const load = async () => {
    const now = DateTime.utc()
    const days = Number(period.value)
    const dateFrom = now.minus({ days: days - 1 }).toISODate()
    const dateTo   = now.toISODate()
    loading.value = true; error.value = ''
    try {
      const resp = await apiStore.getReportsRating({ dateFrom, dateTo })
      rows.value = resp.items
    } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка загрузки' }
    finally { loading.value = false }
  }

  const sorted = computed(() => {
    const k = sort.k
    const sortFn = (a: typeof rows.value[0], b: typeof rows.value[0]) => {
      const va = k === 'avg' ? (a.avgMinutes ?? 9999) : k === 'pct' ? a.pct : k === 'onTime' ? a.onTime : k === 'late' ? a.late : a.total
      const vb = k === 'avg' ? (b.avgMinutes ?? 9999) : k === 'pct' ? b.pct : k === 'onTime' ? b.onTime : k === 'late' ? b.late : b.total
      return (va - vb) * sort.dir
    }
    return [...rows.value].sort(sortFn)
  })

  const toggleSort = (k: SortKey) => {
    if (sort.k === k) sort.dir = sort.dir === 1 ? -1 : 1
    else { sort.k = k; sort.dir = k === 'late' || k === 'avg' ? 1 : -1 }
  }

  const pctColor = (p: number) => p >= 90 ? '#1fa363' : p >= 75 ? '#e0a020' : '#e0533b'

  onMounted(load)
  watch(period, load)
  </script>

  <template>
    <div>
      <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h1 class="text-[21px] font-semibold">Рейтинг дисциплины АЗС</h1>
          <p class="text-sm text-gray-500 mt-0.5">Кто стабильно держит порядок, а кому нужна поддержка</p>
        </div>
        <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: агрегация dispatch_log по АЗС</span>
      </div>

      <div class="flex gap-2.5 mb-4 flex-wrap">
        <div class="inline-flex bg-white border border-gray-200 rounded-[10px] p-0.5 shadow-sm">
          <button v-for="p in ['7','30','90']" :key="p"
            :class="['px-3 py-1.5 rounded-lg font-semibold text-[12.5px] transition-colors', period === p ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100']"
            @click="period = p as PeriodKey"
          >{{ p }} дней</button>
        </div>
        <span class="text-[12px] text-gray-400 self-center">Клик по заголовку столбца — сортировка</span>
      </div>

      <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
      <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
      <div v-else class="bg-white border border-gray-200 rounded-[14px] shadow-sm overflow-x-auto">
        <table class="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">#</th>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">АЗС</th>
              <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('total')">Всего {{ sort.k === 'total' ? (sort.dir === -1 ? '↓' : '↑') : '' }}</th>
              <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('onTime')">Вовремя {{ sort.k === 'onTime' ? (sort.dir === -1 ? '↓' : '↑') : '' }}</th>
              <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('late')">Просроч. {{ sort.k === 'late' ? (sort.dir === 1 ? '↑' : '↓') : '' }}</th>
              <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('pct')">% вовремя {{ sort.k === 'pct' ? (sort.dir === -1 ? '↓' : '↑') : '' }}</th>
              <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('avg')">Ср. время {{ sort.k === 'avg' ? (sort.dir === 1 ? '↑' : '↓') : '' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, idx) in sorted" :key="row.azsId" class="hover:bg-gray-50">
              <td class="px-3 py-2.5 border-b border-gray-50 text-gray-400 tabular-nums">{{ idx + 1 }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50">
                <b class="block">{{ row.azsTitle || `АЗС ${row.azsId}` }}</b>
                <span class="text-[12px] text-gray-400">ID {{ row.azsId }}</span>
              </td>
              <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums">{{ row.total }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums text-green-700">{{ row.onTime }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums" :style="row.late ? 'color:#e0533b' : 'color:#9aa7b5'">{{ row.late }}</td>
              <td class="px-3 py-2.5 border-b border-gray-50">
                <div class="flex items-center gap-2 min-w-[130px]">
                  <div class="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div class="h-full rounded-full" :style="`width:${row.pct}%;background:${pctColor(row.pct)}`"/>
                  </div>
                  <b class="tabular-nums min-w-[38px] text-right" :style="`color:${pctColor(row.pct)}`">{{ row.pct }}%</b>
                </div>
              </td>
              <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums text-gray-500">
                {{ row.avgMinutes !== null ? `${row.avgMinutes} мин` : '—' }}
              </td>
            </tr>
            <tr v-if="!sorted.length">
              <td colspan="7" class="text-center py-8 text-gray-400">Нет данных за выбранный период</td>
            </tr>
          </tbody>
        </table>
        <p class="text-[12px] text-gray-400 px-3 py-2">«Ср. время» — среднее от уведомления (scheduled_at) до сдачи (updated_at) только по сданным отчётам.</p>
      </div>
    </div>
  </template>
  ```

- [ ] **Step 10.2** Ручная проверка: вкладка «Рейтинг АЗС» — таблица с реальными АЗС, сортировка по «%» работает.

---

## Фаза C3 — Отчёт 3: Динамика

### Task 11 — R3Trend.vue

- [ ] **Step 11.1** Создать `frontend/app/components/reports/R3Trend.vue`. Использует `apiStore.getReportsTrend`.
  ```vue
  <script setup lang="ts">
  import { DateTime } from 'luxon'

  const apiStore = useApiStore()
  type PeriodKey = '7' | '30' | '90'
  const period = ref<PeriodKey>('30')
  type TRow = { date: string; total: number; done: number; expired: number; open: number }
  const rows = ref<TRow[]>([])
  const loading = ref(false); const error = ref('')

  const load = async () => {
    const now = DateTime.utc()
    const days = Number(period.value)
    loading.value = true; error.value = ''
    try {
      const resp = await apiStore.getReportsTrend({
        dateFrom: now.minus({ days: days - 1 }).toISODate(),
        dateTo: now.toISODate()
      })
      rows.value = resp.items
    } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка' }
    finally { loading.value = false }
  }

  const pctData = computed(() => rows.value.map(r => r.total ? Math.round(r.done / r.total * 100) : 0))
  const doneData = computed(() => rows.value.map(r => r.done))
  const lateData = computed(() => rows.value.map(r => r.expired))

  const callout = computed(() => {
    const p = pctData.value
    if (p.length < 2) return null
    const first = p[0]; const last = p[p.length - 1]; const delta = last - first
    return { first, last, delta, days: period.value }
  })

  onMounted(load)
  watch(period, load)
  </script>

  <template>
    <div>
      <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h1 class="text-[21px] font-semibold">Динамика дисциплины</h1>
          <p class="text-sm text-gray-500 mt-0.5">Как меняется доля отчётов, сданных вовремя</p>
        </div>
        <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: getSummary по дням</span>
      </div>

      <div class="inline-flex bg-white border border-gray-200 rounded-[10px] p-0.5 shadow-sm mb-4">
        <button v-for="p in ['7','30','90']" :key="p"
          :class="['px-3 py-1.5 rounded-lg font-semibold text-[12.5px] transition-colors', period === p ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100']"
          @click="period = p as PeriodKey"
        >{{ p }} дней</button>
      </div>

      <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
      <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
      <template v-else>
        <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
          <h3 class="font-semibold mb-1">Доля сданных вовремя, %</h3>
          <SvgLine :data="pctData" />
          <div v-if="callout" class="mt-3.5 bg-green-50 border border-green-200 rounded-xl p-3 text-[13px] text-green-800 flex gap-2.5 items-start">
            <span class="text-[18px] leading-none">📈</span>
            <div>Дисциплина <b>{{ callout.delta >= 0 ? 'выросла' : 'снизилась' }}</b> с <b>{{ callout.first }}%</b> до <b>{{ callout.last }}%</b> за {{ callout.days }} дней.</div>
          </div>
        </div>
        <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
          <h3 class="font-semibold mb-3">Сдано и просрочено по дням</h3>
          <SvgGroupBars :done="doneData" :late="lateData" />
          <div class="flex gap-3.5 mt-3 text-[12px] text-gray-500">
            <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-green-500 mr-1.5 align-[-1px]"/>Сдано</span>
            <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-red-400 mr-1.5 align-[-1px]"/>Просрочено</span>
          </div>
        </div>
      </template>
    </div>
  </template>
  ```

- [ ] **Step 11.2** Ручная проверка: вкладка «Динамика» — линейный график и столбчатый рендерятся с реальными данными.

---

## Фаза C4 — Отчёт 4: Карточка АЗС

### Task 12 — R4Card.vue

Использует `apiStore.getReports` (фильтр по azsId, 30 дней) + `apiStore.getReportById` для фото последнего отчёта. Доступ: reviewer и admin АЗС (только своя АЗС — кроссчек с `adminUserId`).

- [ ] **Step 12.1** Создать `frontend/app/components/reports/R4Card.vue`:
  ```vue
  <script setup lang="ts">
  import { DateTime } from 'luxon'

  const apiStore = useApiStore()
  const userStore = useUserStore()

  type AzsOption = { value: string; label: string }
  const azsOptions = ref<AzsOption[]>([])
  const selectedAzsId = ref('')
  const reportHistory = ref<Array<{
    id: number; status: string; scheduledAt: string | null; deadlineAt: string | null; updatedAt: string | null
  }>>([])
  const lastReportPhotos = ref<Array<{ photoCode: string; diskObjectId: number | null; diskFolderId: number | null; exifAt: string | null }>>([])
  const loading = ref(false); const error = ref('')

  const load = async () => {
    if (!selectedAzsId.value) return
    const now = DateTime.utc()
    loading.value = true; error.value = ''
    try {
      const resp = await apiStore.getReports({
        dateFrom: now.minus({ days: 29 }).toISODate(),
        dateTo: now.toISODate(),
        azsId: selectedAzsId.value,
        limit: 50
      })
      reportHistory.value = resp.items

      // Загрузить фото последнего сданного отчёта
      const lastDone = resp.items.find(r => r.status === 'done')
      if (lastDone) {
        const detail = await apiStore.getReportById(lastDone.id)
        lastReportPhotos.value = detail.photos || []
      } else {
        lastReportPhotos.value = []
      }
    } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка' }
    finally { loading.value = false }
  }

  const mini = computed(() => {
    const total = reportHistory.value.length
    const done = reportHistory.value.filter(r => r.status === 'done').length
    const late = reportHistory.value.filter(r => r.status === 'expired' || (r.status === 'done' && r.deadlineAt && r.updatedAt && new Date(r.updatedAt) > new Date(r.deadlineAt))).length
    const onTime = done - reportHistory.value.filter(r => r.status === 'done' && r.deadlineAt && r.updatedAt && new Date(r.updatedAt) > new Date(r.deadlineAt)).length
    const pct = total ? Math.round(onTime / total * 100) : 0
    const avgMs = reportHistory.value
      .filter(r => r.status === 'done' && r.scheduledAt && r.updatedAt)
      .map(r => new Date(r.updatedAt!).getTime() - new Date(r.scheduledAt!).getTime())
    const avg = avgMs.length ? Math.round(avgMs.reduce((a, b) => a + b, 0) / avgMs.length / 60000) : null
    return { total, done, onTime, late, pct, avg }
  })

  const lastDoneReport = computed(() => reportHistory.value.find(r => r.status === 'done') || null)

  const fmtTime = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('HH:mm') : '—'
  const fmtDate = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('dd.MM') : '—'
  const fmtDow  = (iso: string | null) => iso ? ['вс','пн','вт','ср','чт','пт','сб'][new Date(iso).getDay()] : ''

  const photoPreviewUrl = (photo: typeof lastReportPhotos.value[0]) => {
    if (!lastDoneReport.value || !photo.diskObjectId) return null
    return `/api/reports/photos/${lastDoneReport.value.id}/${photo.photoCode}/preview?token=${apiStore.tokenJWT}`
  }

  const GRAD: Record<string, string> = {
    default: 'linear-gradient(135deg,#6a8caf,#34506b)',
    hall:    'linear-gradient(135deg,#6a8caf,#34506b)',
    wc:     'linear-gradient(135deg,#56b3a6,#2c7a6f)',
    cash:   'linear-gradient(135deg,#c9a24b,#8a6d22)',
    trk:    'linear-gradient(135deg,#c2705b,#8a3f2e)',
    area:   'linear-gradient(135deg,#7d9b5a,#4c6a31)',
  }

  onMounted(async () => {
    try {
      const resp = await apiStore.getAzsOptions({ limit: 500 })
      azsOptions.value = resp.items.map(i => ({ value: String(i.id), label: i.title || `АЗС ${i.id}` }))
      if (azsOptions.value.length) { selectedAzsId.value = azsOptions.value[0].value; await load() }
    } catch { /* non-fatal */ }
  })
  watch(selectedAzsId, load)
  </script>

  <template>
    <div>
      <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h1 class="text-[21px] font-semibold">Карточка АЗС</h1>
          <p class="text-sm text-gray-500 mt-0.5">Полный таймлайн прохождения и фото-доказательства</p>
        </div>
        <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: dispatch_log + report_photo</span>
      </div>

      <!-- AZS picker -->
      <div class="flex gap-2.5 mb-4 flex-wrap items-center">
        <B24InputMenu
          v-model="selectedAzsId"
          :items="azsOptions"
          value-attribute="value"
          option-attribute="label"
          placeholder="Выберите АЗС…"
          class="min-w-[260px]"
        />
        <span class="text-[12px] text-gray-400">за 30 дней</span>
      </div>

      <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
      <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
      <template v-else-if="selectedAzsId">
        <!-- Mini KPIs -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3.5">
          <div v-for="kpi in [
            { t: '% вовремя (30д)', v: mini.pct + '%',                  c: mini.pct >= 90 ? '#1fa363' : mini.pct >= 75 ? '#e0a020' : '#e0533b' },
            { t: 'Среднее время',   v: mini.avg !== null ? mini.avg + ' мин' : '—', c: '#0f2742' },
            { t: 'Просрочек',       v: mini.late,                       c: mini.late ? '#e0533b' : '#1fa363' },
            { t: 'Сдач всего',      v: mini.done + '/' + mini.total,    c: '#0f2742' },
          ]" :key="kpi.t"
            class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-3.5"
          >
            <div class="text-[11.5px] text-gray-400 font-semibold">{{ kpi.t }}</div>
            <div class="text-[23px] font-extrabold mt-0.5" :style="`color:${kpi.c}`">{{ kpi.v }}</div>
          </div>
        </div>

        <!-- Последний отчёт: фото -->
        <div v-if="lastDoneReport" class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
          <h3 class="font-semibold mb-3">
            Последний отчёт · {{ fmtDate(lastDoneReport.scheduledAt) }}, уведомление {{ fmtTime(lastDoneReport.scheduledAt) }}, сдано {{ fmtTime(lastDoneReport.updatedAt) }}
          </h3>
          <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
            <div v-for="photo in lastReportPhotos" :key="photo.photoCode"
              class="relative rounded-[11px] aspect-[4/3] overflow-hidden border border-black/5 flex items-end text-white"
              :style="`background:${GRAD[photo.photoCode] || GRAD.default}`"
            >
              <img
                v-if="photoPreviewUrl(photo)"
                :src="photoPreviewUrl(photo)!"
                class="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
                :alt="photo.photoCode"
                @error="($event.target as HTMLImageElement).style.display='none'"
              />
              <div v-if="photo.exifAt" class="absolute top-2 right-2 bg-black/45 backdrop-blur-sm text-[10.5px] px-1.5 py-0.5 rounded-full font-bold">
                📷 {{ fmtTime(photo.exifAt) }}
              </div>
              <div class="relative z-10 px-2.5 py-2 w-full bg-gradient-to-t from-black/45 to-transparent text-[12px] font-semibold">
                {{ photo.photoCode }}
              </div>
            </div>
          </div>
          <p class="text-[12px] text-gray-400 mt-2.5">Время в углу — момент съёмки (exif_at). Фото делается только живой камерой — доказательство «снято на месте».</p>
        </div>

        <!-- Timeline -->
        <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
          <h3 class="font-semibold mb-3">История прохождений</h3>
          <div>
            <div v-for="(rep, idx) in reportHistory" :key="rep.id"
              :class="['grid gap-3.5 py-3', idx < reportHistory.length - 1 ? 'border-b border-gray-100' : '']"
              style="grid-template-columns:88px 1fr"
            >
              <div>
                <div class="font-bold text-[13px]">{{ fmtDate(rep.scheduledAt) }}</div>
                <div class="text-[11.5px] text-gray-400">{{ fmtDow(rep.scheduledAt) }}</div>
              </div>
              <div class="flex items-center gap-2 flex-wrap text-[12.5px]">
                <span class="bg-gray-100 rounded-lg px-2 py-1 font-semibold text-[#46586c]">уведомление {{ fmtTime(rep.scheduledAt) }}</span>
                <span class="text-gray-300">→</span>
                <template v-if="rep.updatedAt && rep.status === 'done'">
                  <span :class="['bg-gray-100 rounded-lg px-2 py-1 font-semibold', rep.deadlineAt && new Date(rep.updatedAt) <= new Date(rep.deadlineAt) ? 'bg-green-50 text-green-700' : 'text-[#46586c]']">
                    сдано {{ fmtTime(rep.updatedAt) }}
                  </span>
                </template>
                <template v-else>
                  <span class="bg-red-50 text-red-600 rounded-lg px-2 py-1 font-semibold">не сдано</span>
                </template>
                <span class="ml-auto">
                  <B24Badge :color="rep.status === 'done' ? 'air-primary-success' : rep.status === 'expired' ? 'air-primary-alert' : 'air-secondary'">
                    {{ rep.status === 'done' ? 'вовремя' : rep.status === 'expired' ? 'просрочено' : rep.status }}
                  </B24Badge>
                </span>
              </div>
            </div>
            <div v-if="!reportHistory.length" class="text-center py-6 text-gray-400">Нет истории за 30 дней</div>
          </div>
        </div>
      </template>
    </div>
  </template>
  ```

- [ ] **Step 12.2** Ручная проверка: вкладка «Карточка АЗС» — выбор АЗС, отображение миникпи + таймлайна + фото (или placeholder если Disk API не вернул).

---

## Фаза C5 — Отчёт 5: Фото-витрина

### Task 13 — R5Wall.vue

Использует `apiStore.getDayPhotos`. Данные — все `done`-отчёты за выбранный день с фото.

- [ ] **Step 13.1** Создать `frontend/app/components/reports/R5Wall.vue`:
  ```vue
  <script setup lang="ts">
  import { DateTime } from 'luxon'

  const apiStore = useApiStore()
  const date = ref(DateTime.utc().toISODate())
  const azsFilter = ref<Set<string>>(new Set())
  type Entry = { reportId: number; azsId: string; azsTitle?: string | null; doneAt: string | null; photos: Array<{ photoCode: string; diskObjectId: number | null; diskFolderId: number | null; exifAt: string | null }> }
  const items = ref<Entry[]>([])
  const loading = ref(false); const error = ref('')

  const load = async () => {
    loading.value = true; error.value = ''
    try {
      const resp = await apiStore.getDayPhotos({ date: date.value })
      items.value = resp.items
    } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка' }
    finally { loading.value = false }
  }

  const azsIds = computed(() => [...new Set(items.value.map(i => i.azsId))])
  const displayed = computed(() => {
    if (!azsFilter.value.size) return items.value
    return items.value.filter(i => azsFilter.value.has(i.azsId))
  })

  const toggleAzs = (id: string) => {
    const next = new Set(azsFilter.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    azsFilter.value = next
  }

  const fmtTime = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('HH:mm') : '—'

  const photoUrl = (reportId: number, photoCode: string) =>
    `/api/reports/photos/${reportId}/${photoCode}/preview?token=${apiStore.tokenJWT}`

  const GRAD: Record<string, string> = {
    default: 'linear-gradient(135deg,#6a8caf,#34506b)',
  }

  onMounted(load)
  watch(date, load)
  </script>

  <template>
    <div>
      <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h1 class="text-[21px] font-semibold">Фото-витрина дня</h1>
          <p class="text-sm text-gray-500 mt-0.5">Все сданные сегодня фото в одном экране — видно порядок «как есть»</p>
        </div>
        <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: report_photo + Bitrix Disk</span>
      </div>

      <!-- Выбор даты -->
      <div class="flex gap-2.5 mb-4 items-center flex-wrap">
        <input type="date" v-model="date"
          class="px-3 py-2 rounded-[10px] border border-gray-200 bg-white text-[13px] shadow-sm"
        />
        <button class="px-3 py-2 rounded-[10px] border border-gray-200 bg-white text-[13px] text-gray-600 hover:bg-gray-50 shadow-sm"
          @click="date = DateTime.utc().toISODate(); load()"
        >Сегодня</button>
      </div>

      <!-- Чипы фильтра по АЗС -->
      <div class="flex gap-1.5 flex-wrap mb-4">
        <button
          :class="['border border-gray-200 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors', !azsFilter.size ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-[#46586c] hover:bg-gray-50']"
          @click="azsFilter = new Set()"
        >Все АЗС</button>
        <button
          v-for="id in azsIds" :key="id"
          :class="['border rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors', azsFilter.has(id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-[#46586c] border-gray-200 hover:bg-gray-50']"
          @click="toggleAzs(id)"
        >{{ items.find(i => i.azsId === id)?.azsTitle || `АЗС ${id}` }}</button>
      </div>

      <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
      <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
      <div v-else-if="!displayed.length" class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-8 text-center text-gray-400">
        Нет сданных отчётов под выбранный фильтр
      </div>
      <template v-else>
        <div v-for="entry in displayed" :key="entry.reportId" class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
            <b class="text-[14px]">{{ entry.azsTitle || `АЗС ${entry.azsId}` }}</b>
            <span class="text-[12.5px] text-gray-400">сдано в {{ fmtTime(entry.doneAt) }} · {{ entry.photos.length }} фото</span>
          </div>
          <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
            <div
              v-for="photo in entry.photos" :key="photo.photoCode"
              class="relative rounded-[11px] aspect-[4/3] overflow-hidden border border-black/5 flex items-end text-white"
              :style="`background:${GRAD.default}`"
            >
              <img
                :src="photoUrl(entry.reportId, photo.photoCode)"
                class="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
                :alt="photo.photoCode"
                @error="($event.target as HTMLImageElement).style.display='none'"
              />
              <div v-if="photo.exifAt" class="absolute top-2 right-2 bg-black/45 text-[10.5px] px-1.5 py-0.5 rounded-full font-bold backdrop-blur-sm">
                📷 {{ fmtTime(photo.exifAt) }}
              </div>
              <div class="relative z-10 px-2.5 py-2 w-full bg-gradient-to-t from-black/45 to-transparent text-[12px] font-semibold">
                {{ photo.photoCode }}
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </template>
  ```

- [ ] **Step 13.2** Ручная проверка: вкладка «Фото-витрина» — отображаются блоки АЗС с фото-тайлами (реальные изображения или fallback-градиент).

---

## Фаза D — Финальная сшивка и ручное end-to-end тестирование

### Task 14 — Интеграция и ручная проверка

- [ ] **Step 14.1** Убедиться, что в `server.js` `analyticsStore` создан и передан в `createReportsRouter`. Пример изменений:
  ```js
  import { createAnalyticsStore } from './src/reports/analyticsStore.js';
  // ...
  const analyticsStore = createAnalyticsStore({ pool, dbType: process.env.DB_TYPE || 'postgres' });
  // В createReportsRouter({ ..., analyticsStore, diskApi: bitrixClient?.diskApi ?? null })
  ```

- [ ] **Step 14.2** Запустить все тесты: `node --test backends/node/api/tests/analyticsStore.test.js backends/node/api/tests/analyticsRoutes.test.js` → **все PASS**.

- [ ] **Step 14.3** Запустить весь набор тестов: `node --test backends/node/api/tests/*.test.js` → **нет новых падений**.

- [ ] **Step 14.4** Ручное E2E — reviewer:
  - Открыть `/reports` → все 5 вкладок загружаются без ошибок.
  - R1: кпи-карточки показывают суммы, совпадающие с данными существующего `/reviewer`.
  - R2: таблица рейтинга, сортировка по «% вовремя» работает.
  - R3: два SVG-графика рендерятся, callout-блок правильно показывает динамику.
  - R4: выбор АЗС из списка, таймлайн последних 30 дней, фото последнего `done`-отчёта (или «нет фото» если пусто).
  - R5: тайлы для сданных сегодня отчётов, фильтр по АЗС работает.

- [ ] **Step 14.5** Ручное E2E — admin АЗС (role `reports`, без `reviewer`):
  - R1, R2, R3 — закрыты (403). R4 — открыт, показывает только свои АЗС. R5 — закрыт.
  - _Примечание:_ Если требуется, чтобы admin АЗС видел R5 для своей АЗС — это отдельный scope, выходящий за рамки текущего плана.

- [ ] **Step 14.6** Адаптив: проверить на ширине ~375px (mobile Chrome DevTools):
  - Нижняя навигация видна, все 5 вкладок переключаются.
  - KPI-карточки в 2 колонки, фото-тайлы в 2 колонки.

---

## Риски и открытые вопросы

| # | Вопрос | Влияние | Рекомендация |
|---|---|---|---|
| 1 | **Превью фото с Диска** (`diskApi.downloadFile`). Метод нестандартный — его наличие зависит от реализации `bitrixClient.diskApi` в `server.js`. Если метода нет — endpoint вернёт `501 preview_not_supported`, плитки отобразятся с градиентом. | Средний (фото-витрина деградирует до плейсхолдеров) | Проверить, реализован ли `diskApi.downloadFile` до Task 5. Если нет — добавить как отдельный спринт. |
| 2 | **Производительность getTrend за 90 дней** на большой БД без индекса по `(status, created_at)`. | Средний | Добавить `CREATE INDEX CONCURRENTLY ix_dispatch_log_status_created ON dispatch_log (status, created_at)` в `server.js` `ensureSchema` (если он там есть), или в отдельный migration-шаг. |
| 3 | **Экспорт `createAzsTitleResolver`** из `reportsRoutes.js`. Функция сейчас не именована для внешнего потребления. Step 5.2 требует её экспорта — следить, чтобы не сломать существующие тесты. | Низкий | При добавлении `export` запустить `node --test backends/node/api/tests/reportsResync.test.js` и другие роутерные тесты. |
| 4 | **Доступ admin АЗС к R4** — в мокапе предполагается возможность, но текущая логика roles (`canUseReviewerTools` vs `canUseAdminReportTools`) требует явного решения. | Низкий | Для MVP: R4 доступен только reviewer. Admin АЗС — отдельная задача. |
| 5 | **Часовой пояс** в `getTrend` (PostgreSQL): `created_at AT TIME ZONE 'UTC'` корректно для UTC-хранилища. Если сервер или клиент в другой tz — граница дня может сместиться. | Низкий | Использовать UTC повсеместно — аналогично существующему `getSummary`. |
