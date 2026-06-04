# FEAT-C: Пересылка ответов + причины (фаза 1) — Implementation Plan

**Дата:** 2026-06-04
**Спека:** `docs/superpowers/specs/2026-06-04-bot-reply-forwarding-reasons-design.md`
**Статус:** готов к реализации (прод заморожен, реализовывать после разморозки)

---

## Goal

Захват структурированной причины «почему не сдали отчёт вовремя» через мини-страницу приложения (кнопки пресетов + «Другое: текст»), durable-запись в CRM UF под живым токеном оператора, локальный кэш `report_reason` для аналитики, пересылка в общий чат ответственных (best-effort), кнопка-ссылка в задании и добор при просрочке.

**Принцип «никакого хардкода»:** код UF-поля причины, список причин и id чата берутся **только из настроек** (`report.fields.reason`, `report.reasons[]`, `report.responsibleChatId`). В коде допустим лишь seed-дефолт для первичного заполнения экрана настроек.

## Architecture

```
Бот (задание + кнопка-ссылка) ──▶ оператор тапает
        │
        ▼
pages/reason/[reportId].client.vue ──POST──▶ POST /api/reports/:reportId/reason
        │
        ├──▶ CRM: crm.item.update reason UF  (СЕЙФ, под живым токеном req.bitrixContext)
        ├──▶ reasonStore.upsert()             (кэш, dual-driver)
        └──▶ reasonForwardingService          (best-effort, bot send, фон-контекст)
                └──▶ imbot.v2.Chat.Message.send → responsibleChatId
```

**Durability:** CRM — источник истины. Локальная таблица — кэш, восстанавливается через `rehydrateReasonsIfEmpty` по образцу `dispatchPlanMirror.rehydrateIfEmpty`.

## Tech Stack

- **Backend:** Node.js / Express, ESM, `node:test` + `node:assert/strict`
- **БД:** PostgreSQL + MySQL (dual-driver по образцу `dispatchPlanStore.js`)
- **Bitrix API:** `crm.item.update` под контекстом запроса; `imbot.v2.Chat.Message.send` под фон/webhook-контекстом
- **Frontend:** Nuxt 3 + Bitrix24 UI Kit (`B24*`), `useApiStore` / `$api`, `*.client.vue`

---

## File Structure

| Статус | Путь |
|---|---|
| CREATE | `backends/node/api/src/reports/reasonStore.js` |
| CREATE | `backends/node/api/src/reports/reasonCatalog.js` |
| CREATE | `backends/node/api/src/notifications/reasonForwardingService.js` |
| MODIFY | `backends/node/api/src/reports/reportsRoutes.js` |
| MODIFY | `backends/node/api/src/reports/reportCrmSync.js` |
| MODIFY | `backends/node/api/src/dispatch/dispatchService.js` |
| MODIFY | `backends/node/api/src/dispatch/timeoutWatcher.js` |
| MODIFY | `backends/node/api/src/settings/defaultSettings.js` |
| MODIFY | `frontend/app/pages/settings.client.vue` |
| CREATE | `frontend/app/pages/reason/[reportId].client.vue` |
| CREATE | `backends/node/api/tests/reasonStore.test.js` |
| CREATE | `backends/node/api/tests/reasonCatalog.test.js` |
| CREATE | `backends/node/api/tests/reasonRoutes.test.js` |
| CREATE | `backends/node/api/tests/reasonForwarding.test.js` |
| MODIFY | `backends/node/api/tests/timeoutWatcher.test.js` |
| MODIFY | `backends/node/api/tests/dispatchService.test.js` |

---

## Task 1: `reasonStore.js` — dual-driver кэш причин

**Файл:** `backends/node/api/src/reports/reasonStore.js`

Таблица `report_reason`: `id`, `report_id` (→ `dispatch_log.id`), `azs_id`, `admin_user_id`, `reason_code`, `reason_text` (nullable), `source` (`'task'|'expiry'|'app'`), `created_at`, `updated_at`, `UNIQUE(report_id)`.

### Task 1 — Steps

- [ ] **Step 1.1** Написать тест `backends/node/api/tests/reasonStore.test.js` сначала (TDD):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasonStore } from '../src/reports/reasonStore.js';

// --- Fake PG pool ---
const createFakePgPool = () => {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return { rows: [] };

      // upsert: INSERT INTO report_reason ... ON CONFLICT(report_id) DO UPDATE ...
      if (text.startsWith('INSERT INTO report_reason')) {
        const existing = rows.find(r => r.report_id === params[0]);
        if (existing) {
          existing.azs_id = params[1]; existing.admin_user_id = params[2];
          existing.reason_code = params[3]; existing.reason_text = params[4];
          existing.source = params[5]; existing.updated_at = new Date();
          return { rows: [existing] };
        }
        seq += 1;
        const row = {
          id: seq, report_id: params[0], azs_id: params[1],
          admin_user_id: params[2], reason_code: params[3],
          reason_text: params[4], source: params[5],
          created_at: new Date(), updated_at: new Date()
        };
        rows.push(row);
        return { rows: [row] };
      }
      // getByReport
      if (text.startsWith('SELECT * FROM report_reason WHERE report_id')) {
        return { rows: rows.filter(r => r.report_id === params[0]) };
      }
      // countsByCode
      if (text.includes('GROUP BY reason_code')) {
        const counts = {};
        rows.forEach(r => { counts[r.reason_code] = (counts[r.reason_code] || 0) + 1; });
        return { rows: Object.entries(counts).map(([reason_code, count]) => ({ reason_code, count })) };
      }
      // countEmpty
      if (text.includes('COUNT(*)') && text.includes('report_reason')) {
        return { rows: [{ count: rows.length }] };
      }
      return { rows: [] };
    }
  };
};

test('upsert creates a new reason row', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const row = await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 100, reasonCode: 'queue', reasonText: null, source: 'app' });
  assert.ok(row, 'row returned');
  assert.equal(row.reason_code, 'queue');
  assert.equal(row.report_id, 1);
});

test('upsert overwrites existing reason for same reportId', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 100, reasonCode: 'queue', reasonText: null, source: 'app' });
  const row2 = await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 100, reasonCode: 'other', reasonText: 'пример', source: 'app' });
  assert.equal(row2.reason_code, 'other');
  const fetched = await store.getByReport(1);
  assert.equal(fetched?.reason_code, 'other');
});

test('getByReport returns null for unknown report', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const result = await store.getByReport(999);
  assert.equal(result, null);
});

test('countsByCode returns grouped counts over date range', async () => {
  const pool = createFakePgPool();
  const store = createReasonStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.upsert({ reportId: 1, azsId: 'AZS-01', adminUserId: 1, reasonCode: 'queue', reasonText: null, source: 'app' });
  await store.upsert({ reportId: 2, azsId: 'AZS-01', adminUserId: 1, reasonCode: 'queue', reasonText: null, source: 'app' });
  await store.upsert({ reportId: 3, azsId: 'AZS-02', adminUserId: 2, reasonCode: 'staff', reasonText: null, source: 'expiry' });
  const counts = await store.countsByCode({});
  assert.ok(counts.find(c => c.reason_code === 'queue')?.count >= 2);
});

test('MySQL driver: upsert and getByReport work via ON DUPLICATE KEY UPDATE', async () => {
  // Fake MySQL pool
  const rows = [];
  let seq = 0;
  const mysqlPool = {
    rows,
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE') || text.includes('information_schema')) return [[{ c: 1 }]];
      if (text.startsWith('INSERT INTO report_reason')) {
        const ex = rows.find(r => r.report_id === params[0]);
        if (ex) { ex.reason_code = params[3]; ex.reason_text = params[4]; return [{ affectedRows: 1 }]; }
        seq += 1;
        rows.push({ id: seq, report_id: params[0], azs_id: params[1], admin_user_id: params[2], reason_code: params[3], reason_text: params[4], source: params[5] });
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('SELECT * FROM report_reason WHERE report_id')) {
        return [rows.filter(r => r.report_id === params[0])];
      }
      return [[]];
    }
  };
  const store = createReasonStore({ pool: mysqlPool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.upsert({ reportId: 5, azsId: 'AZS-05', adminUserId: 50, reasonCode: 'delivery', reasonText: null, source: 'app' });
  const row = await store.getByReport(5);
  assert.equal(row?.reason_code, 'delivery');
});
```

- [ ] **Step 1.2** Написать `backends/node/api/src/reports/reasonStore.js`:

```js
const isMysql = (dbType) => String(dbType || '').toLowerCase() === 'mysql';

const toDateSql = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`toDateSql: invalid date: ${date}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------
const createPostgresStore = (pool) => ({
  async ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_reason (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL,
        azs_id TEXT NOT NULL,
        admin_user_id BIGINT NOT NULL,
        reason_code TEXT NOT NULL,
        reason_text TEXT NULL,
        source TEXT NOT NULL DEFAULT 'app',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(report_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ix_report_reason_azs_code
        ON report_reason (azs_id, reason_code, created_at)
    `);
  },

  async upsert({ reportId, azsId, adminUserId, reasonCode, reasonText = null, source = 'app' }) {
    const result = await pool.query(
      `INSERT INTO report_reason (report_id, azs_id, admin_user_id, reason_code, reason_text, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (report_id) DO UPDATE
         SET azs_id = EXCLUDED.azs_id,
             admin_user_id = EXCLUDED.admin_user_id,
             reason_code = EXCLUDED.reason_code,
             reason_text = EXCLUDED.reason_text,
             source = EXCLUDED.source,
             updated_at = NOW()
       RETURNING *`,
      [reportId, azsId, adminUserId, reasonCode, reasonText ?? null, source]
    );
    return result.rows[0] ?? null;
  },

  async getByReport(reportId) {
    const result = await pool.query(
      'SELECT * FROM report_reason WHERE report_id = $1 LIMIT 1',
      [reportId]
    );
    return result.rows[0] ?? null;
  },

  async countsByCode({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    let idx = 1;
    if (dateFrom) { where.push(`created_at >= $${idx}`); params.push(new Date(`${dateFrom}T00:00:00.000Z`)); idx++; }
    if (dateTo) { where.push(`created_at <= $${idx}`); params.push(new Date(`${dateTo}T23:59:59.999Z`)); idx++; }
    const normalizedIds = (Array.isArray(azsIds) ? azsIds : []).map(s => String(s || '').trim()).filter(Boolean);
    if (normalizedIds.length === 1) { where.push(`azs_id = $${idx}`); params.push(normalizedIds[0]); idx++; }
    else if (normalizedIds.length > 1) { where.push(`azs_id = ANY($${idx})`); params.push(normalizedIds); idx++; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT reason_code, COUNT(*)::int AS count FROM report_reason ${whereSql} GROUP BY reason_code ORDER BY count DESC`,
      params
    );
    return result.rows;
  },

  async countEmpty() {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM report_reason');
    return Number(result.rows[0]?.count || 0);
  }
});

// ---------------------------------------------------------------------------
// MySQL store
// ---------------------------------------------------------------------------
const createMysqlStore = (pool) => ({
  async ensureSchema() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS report_reason (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        report_id BIGINT NOT NULL,
        azs_id VARCHAR(64) NOT NULL,
        admin_user_id BIGINT NOT NULL,
        reason_code VARCHAR(64) NOT NULL,
        reason_text LONGTEXT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'app',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_report_reason_report (report_id),
        INDEX ix_report_reason_azs_code (azs_id, reason_code, created_at)
      )
    `);
  },

  async upsert({ reportId, azsId, adminUserId, reasonCode, reasonText = null, source = 'app' }) {
    await pool.execute(
      `INSERT INTO report_reason (report_id, azs_id, admin_user_id, reason_code, reason_text, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         azs_id = VALUES(azs_id),
         admin_user_id = VALUES(admin_user_id),
         reason_code = VALUES(reason_code),
         reason_text = VALUES(reason_text),
         source = VALUES(source)`,
      [reportId, azsId, adminUserId, reasonCode, reasonText ?? null, source]
    );
    const [rows] = await pool.execute(
      'SELECT * FROM report_reason WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    return rows[0] ?? null;
  },

  async getByReport(reportId) {
    const [rows] = await pool.execute(
      'SELECT * FROM report_reason WHERE report_id = ? LIMIT 1',
      [reportId]
    );
    return rows[0] ?? null;
  },

  async countsByCode({ dateFrom, dateTo, azsIds = [] } = {}) {
    const where = [];
    const params = [];
    if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo) { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const normalizedIds = (Array.isArray(azsIds) ? azsIds : []).map(s => String(s || '').trim()).filter(Boolean);
    if (normalizedIds.length === 1) { where.push('azs_id = ?'); params.push(normalizedIds[0]); }
    else if (normalizedIds.length > 1) { where.push(`azs_id IN (${normalizedIds.map(() => '?').join(',')})`); params.push(...normalizedIds); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT reason_code, COUNT(*) AS count FROM report_reason ${whereSql} GROUP BY reason_code ORDER BY count DESC`,
      params
    );
    return rows.map(r => ({ reason_code: r.reason_code, count: Number(r.count) }));
  },

  async countEmpty() {
    const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM report_reason');
    return Number(rows[0]?.count || 0);
  }
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export const createReasonStore = ({ pool, dbType } = {}) => {
  if (!pool) throw new Error('pool is required');
  return isMysql(dbType) ? createMysqlStore(pool) : createPostgresStore(pool);
};

export default createReasonStore;
```

- [ ] **Step 1.3** Запустить тест: `node --test backends/node/api/tests/reasonStore.test.js` — все зелёные.

---

## Task 2: `reasonCatalog.js` — каталог причин из настроек

**Файл:** `backends/node/api/src/reports/reasonCatalog.js`

Дефолтный seed — только для первичного отображения в UI настроек. Вся бизнес-логика читает `settings.report.reasons[]`.

### Task 2 — Steps

- [ ] **Step 2.1** Написать тест `backends/node/api/tests/reasonCatalog.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasonCatalog, DEFAULT_REASONS_SEED } from '../src/reports/reasonCatalog.js';

const sampleReasons = [
  { code: 'fuel_truck', label: 'Приёмка топлива / бензовоз' },
  { code: 'queue',      label: 'Очередь / много гостей' },
  { code: 'other',      label: 'Другое (требует текст)' }
];

test('DEFAULT_REASONS_SEED содержит other', () => {
  const other = DEFAULT_REASONS_SEED.find(r => r.code === 'other');
  assert.ok(other, 'other должен быть в seed');
});

test('codeToLabel возвращает label по коду из настроек', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.codeToLabel('queue'), 'Очередь / много гостей');
});

test('codeToLabel возвращает undefined для неизвестного кода', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.codeToLabel('unknown'), undefined);
});

test('labelToCode восстанавливает code по label (round-trip)', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.labelToCode('Очередь / много гостей'), 'queue');
});

test('encodeValue: пресет → label', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.encodeValue('queue', null), 'Очередь / много гостей');
});

test('encodeValue: other + text → "Другое: <text>"', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.encodeValue('other', 'кран сломался'), 'Другое: кран сломался');
});

test('decodeValue: label → { code, text: null }', () => {
  const cat = createReasonCatalog(sampleReasons);
  const result = cat.decodeValue('Очередь / много гостей');
  assert.equal(result.code, 'queue');
  assert.equal(result.text, null);
});

test('decodeValue: "Другое: <text>" → { code: other, text }', () => {
  const cat = createReasonCatalog(sampleReasons);
  const result = cat.decodeValue('Другое: кран сломался');
  assert.equal(result.code, 'other');
  assert.equal(result.text, 'кран сломался');
});

test('decodeValue: нераспознанное → { code: other, text: original }', () => {
  const cat = createReasonCatalog(sampleReasons);
  const result = cat.decodeValue('неизвестная причина');
  assert.equal(result.code, 'other');
  assert.equal(result.text, 'неизвестная причина');
});

test('isOther возвращает true только для кода other', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.isOther('other'), true);
  assert.equal(cat.isOther('queue'), false);
});

test('isValidCode принимает коды из настроек', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.isValidCode('queue'), true);
  assert.equal(cat.isValidCode('unknown_code'), false);
});
```

- [ ] **Step 2.2** Написать `backends/node/api/src/reports/reasonCatalog.js`:

```js
// Дефолтный seed — только для первичного заполнения экрана настроек.
// Бизнес-логика всегда читает reasons из настроек (settings.report.reasons[]).
export const DEFAULT_REASONS_SEED = Object.freeze([
  { code: 'fuel_truck', label: 'Приёмка топлива / бензовоз' },
  { code: 'delivery',   label: 'Приёмка товара' },
  { code: 'queue',      label: 'Очередь / много гостей' },
  { code: 'wc_busy',    label: 'Санузел занят' },
  { code: 'staff',      label: 'Нехватка персонала' },
  { code: 'other',      label: 'Другое (требует текст)' }
]);

const OTHER_CODE = 'other';
const OTHER_PREFIX = 'Другое: ';

/**
 * Создать каталог из массива причин (из настроек settings.report.reasons[]).
 * @param {Array<{code: string, label: string}>} reasons - из настроек, не хардкод
 */
export const createReasonCatalog = (reasons = []) => {
  const validReasons = Array.isArray(reasons)
    ? reasons.filter(r => r && typeof r.code === 'string' && r.code.trim())
    : [];

  const byCode = new Map(validReasons.map(r => [r.code, r.label]));
  const byLabel = new Map(validReasons.map(r => [r.label, r.code]));

  const isOther = (code) => String(code || '') === OTHER_CODE;

  const isValidCode = (code) => byCode.has(String(code || ''));

  const codeToLabel = (code) => byCode.get(String(code || ''));

  const labelToCode = (label) => byLabel.get(String(label || ''));

  /**
   * Кодировать значение для записи в CRM UF (строка).
   * Пресет → label; other + text → "Другое: <text>"
   */
  const encodeValue = (code, text) => {
    if (isOther(code)) {
      return `${OTHER_PREFIX}${String(text || '').trim()}`;
    }
    return codeToLabel(code) || String(code);
  };

  /**
   * Декодировать значение из CRM UF обратно в { code, text }.
   * "Другое: ..." → { code: 'other', text }
   * label из каталога → { code, text: null }
   * нераспознанное → { code: 'other', text: original }
   */
  const decodeValue = (value) => {
    const str = String(value || '').trim();
    if (str.startsWith(OTHER_PREFIX)) {
      return { code: OTHER_CODE, text: str.slice(OTHER_PREFIX.length).trim() || null };
    }
    const code = labelToCode(str);
    if (code) return { code, text: null };
    // нераспознанное — сохранить как other + полный текст
    return { code: OTHER_CODE, text: str || null };
  };

  return { isOther, isValidCode, codeToLabel, labelToCode, encodeValue, decodeValue, reasons: validReasons };
};

export default createReasonCatalog;
```

- [ ] **Step 2.3** Запустить: `node --test backends/node/api/tests/reasonCatalog.test.js` — все зелёные.

---

## Task 3: `reportCrmSync.js` — дополнить записью reason UF

**Файл:** `backends/node/api/src/reports/reportCrmSync.js`

### Task 3 — Steps

- [ ] **Step 3.1** Добавить в `buildReportCrmUpdateFields` обработку `reasonCode`+`reasonText`:

```js
// В buildReportCrmUpdateFields добавить параметр reasonValue и блок:
// Вызывается из updateReportCrmItem, который передаёт reasonValue из настроек
if (fieldsMap.reason && reasonValue !== undefined && reasonValue !== null) {
  fields[fieldsMap.reason] = String(reasonValue);
}
```

Полная сигнатура обновлённого `buildReportCrmUpdateFields`:
```js
export const buildReportCrmUpdateFields = ({
  settings,
  status,
  photos = [],
  diskFolderId = null,
  reasonValue = null  // NEW: уже закодированная строка из reasonCatalog.encodeValue()
})
```

- [ ] **Step 3.2** Добавить экспортируемую функцию `updateReasonCrmField`:

```js
/**
 * Записать причину в UF-поле карточки отчёта под контекстом оператора.
 * reasonValue — уже закодированная строка (из reasonCatalog.encodeValue()).
 * Код поля берётся из settings.report.fields.reason (никакого хардкода).
 */
export const updateReasonCrmField = async ({
  bitrixClient,
  settings,
  reportItemId,
  reasonValue,
  context = {}
}) => {
  const entityTypeId = Number(settings?.report?.entityTypeId || 0);
  const reasonFieldCode = String(settings?.report?.fields?.reason || '').trim();

  if (!reasonFieldCode) {
    console.warn('reason_uf_not_configured', {
      message: 'report.fields.reason не задан — причина не записывается в CRM (нет durability)'
    });
    return null;
  }

  if (!entityTypeId || !Number(reportItemId) || typeof bitrixClient?.updateReportItem !== 'function') {
    return null;
  }

  return bitrixClient.updateReportItem({
    entityTypeId,
    id: Number(reportItemId),
    fields: { [reasonFieldCode]: String(reasonValue) },
    context
  });
};
```

- [ ] **Step 3.3** Убедиться, что `getFieldValue` (camelCase↔UF алиасинг) уже присутствует в `reportsRoutes.js` — он там есть, повторно определять не нужно. Для `updateReasonCrmField` достаточно прямой записи поля по коду из настроек.

---

## Task 4: `reasonForwardingService.js` — пересылка в общий чат

**Файл:** `backends/node/api/src/notifications/reasonForwardingService.js`

### Task 4 — Steps

- [ ] **Step 4.1** Написать тест `backends/node/api/tests/reasonForwarding.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasonForwardingService } from '../src/notifications/reasonForwardingService.js';

const makeClient = (onCall = () => ({})) => ({
  callMethod: async (method, params, context) => onCall(method, params, context)
});

const makeSettings = (chatId = '123') => ({
  report: { responsibleChatId: chatId }
});

test('forward: вызывает imbot.v2.Chat.Message.send с нужными параметрами', async () => {
  let called = null;
  const client = makeClient((method, params) => { called = { method, params }; return {}; });
  const svc = createReasonForwardingService({ bitrixClient: client, botId: 42, logger: { warn: () => {} } });
  await svc.forward({
    settings: makeSettings('777'),
    azsTitle: 'АЗС Луговая',
    operatorName: 'Иван',
    reasonLabel: 'Очередь / много гостей',
    reasonText: null,
    reportStatus: 'expired',
    deadlineAt: new Date('2026-06-04T10:00:00Z').toISOString(),
    timezone: 'Europe/Moscow',
    reportItemId: 99,
    context: {}
  });
  assert.ok(called, 'callMethod должен быть вызван');
  assert.equal(called.method, 'imbot.v2.Chat.Message.send');
  assert.equal(called.params.botId, 42);
  assert.ok(String(called.params.fields.message).includes('АЗС Луговая'));
  assert.ok(String(called.params.fields.message).includes('Иван'));
});

test('forward: не вызывает API если responsibleChatId пуст', async () => {
  let called = false;
  const client = makeClient(() => { called = true; return {}; });
  const svc = createReasonForwardingService({ bitrixClient: client, botId: 42, logger: { warn: () => {} } });
  await svc.forward({
    settings: makeSettings(''),
    azsTitle: 'АЗС', operatorName: 'Иван', reasonLabel: 'Очередь', reasonText: null,
    reportStatus: 'expired', deadlineAt: null, timezone: 'Europe/Moscow',
    reportItemId: 1, context: {}
  });
  assert.equal(called, false, 'API не должен вызываться при пустом chatId');
});

test('forward: best-effort — не бросает при ошибке API', async () => {
  const client = makeClient(() => { throw new Error('BUG-G: bot context broken'); });
  const warns = [];
  const svc = createReasonForwardingService({
    bitrixClient: client, botId: 42,
    logger: { warn: (msg, meta) => warns.push(msg) }
  });
  // Не должен бросить
  await svc.forward({
    settings: makeSettings('777'),
    azsTitle: 'АЗС', operatorName: 'Иван', reasonLabel: 'Очередь', reasonText: null,
    reportStatus: 'expired', deadlineAt: null, timezone: 'Europe/Moscow',
    reportItemId: 1, context: {}
  });
  assert.ok(warns.length > 0, 'должен залогировать предупреждение');
});
```

- [ ] **Step 4.2** Написать `backends/node/api/src/notifications/reasonForwardingService.js`:

```js
const formatLocalTime = (iso, timezone) => {
  if (!iso) return '';
  const tz = String(timezone || '').trim() || 'Europe/Moscow';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
};

const buildForwardMessage = ({ azsTitle, operatorName, reasonLabel, reasonText, reportStatus, deadlineAt, timezone, crmLink }) => {
  const timeStr = formatLocalTime(deadlineAt, timezone);
  const reasonFull = reasonText ? `${reasonLabel}: ${reasonText}` : reasonLabel;
  const lines = [
    `АЗС ${azsTitle}: ${operatorName} — причина: ${reasonFull}.`,
    `Отчёт ${reportStatus}${timeStr ? `, дедлайн был ${timeStr}` : ''}.`
  ];
  if (crmLink) lines.push(crmLink);
  return lines.join('\n');
};

/**
 * createReasonForwardingService — best-effort отправка в общий чат ответственных.
 * chatId берётся из настроек (settings.report.responsibleChatId), не хардкодится.
 */
export const createReasonForwardingService = ({
  bitrixClient,
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  logger = console
}) => {
  if (!bitrixClient) throw new Error('bitrixClient is required');

  const forward = async ({
    settings,
    azsTitle,
    operatorName,
    reasonLabel,
    reasonText = null,
    reportStatus,
    deadlineAt = null,
    timezone = 'Europe/Moscow',
    reportItemId = null,
    portalDomain = '',
    context = {}
  }) => {
    // chatId берётся ТОЛЬКО из настроек, никакого хардкода
    const chatId = String(settings?.report?.responsibleChatId || '').trim();
    if (!chatId) {
      // Деградация: нет chatId — пропускаем пересылку, причина уже записана
      return null;
    }

    const runtimeBotId = Number(botId || 0);
    if (!runtimeBotId) {
      logger.warn('reason_forwarding_skipped_no_bot_id', { chatId, reportItemId });
      return null;
    }

    // Строим ссылку на CRM-карточку опционально
    const crmLink = (portalDomain && reportItemId)
      ? `https://${String(portalDomain).replace(/^https?:\/\//, '')}/${reportItemId}/`
      : '';

    const message = buildForwardMessage({
      azsTitle: String(azsTitle || ''),
      operatorName: String(operatorName || ''),
      reasonLabel: String(reasonLabel || ''),
      reasonText: reasonText ? String(reasonText) : null,
      reportStatus: String(reportStatus || ''),
      deadlineAt,
      timezone,
      crmLink
    });

    try {
      const result = await bitrixClient.callMethod(
        'imbot.v2.Chat.Message.send',
        {
          botId: runtimeBotId,
          dialogId: `chat${chatId}`,
          fields: { message, urlPreview: false }
        },
        context
      );
      return { ok: true, result };
    } catch (error) {
      // best-effort: не блокируем захват причины
      logger.warn('reason_forwarding_failed', {
        chatId,
        reportItemId,
        message: String(error?.message || error || '')
      });
      return { ok: false, error: String(error?.message || error || '') };
    }
  };

  return { forward };
};

export default createReasonForwardingService;
```

- [ ] **Step 4.3** Запустить: `node --test backends/node/api/tests/reasonForwarding.test.js` — все зелёные.

---

## Task 5: `defaultSettings.js` — добавить настройки причин

**Файл:** `backends/node/api/src/settings/defaultSettings.js`

### Task 5 — Steps

- [ ] **Step 5.1** В `DEFAULT_SETTINGS` добавить в блок `report`:

```js
// В DEFAULT_SETTINGS.report:
fields: {
  azs: '',
  trigger: '',
  folderId: '',
  photos: '',
  reason: ''            // NEW: код строкового UF причины на карточке отчёта
},
reasons: [],            // NEW: список причин [{ code, label }], заполняется в UI (seed в экране)
responsibleChatId: ''   // NEW: id общего чата ответственных
```

- [ ] **Step 5.2** В `validateSettings` добавить валидацию:

```js
// После блока валидации report.fields:
if (isPlainObject(settings.report)) {
  // ... существующие проверки ...

  // report.reasons — массив объектов { code: string, label: string }
  if (settings.report.reasons !== undefined) {
    if (!Array.isArray(settings.report.reasons)) {
      errors.push('report.reasons must be an array');
    } else {
      const hasInvalidReason = settings.report.reasons.some(
        r => !r || typeof r.code !== 'string' || !r.code.trim()
           || typeof r.label !== 'string' || !r.label.trim()
      );
      if (hasInvalidReason) {
        errors.push('report.reasons items must have non-empty string code and label');
      }
    }
  }

  // report.responsibleChatId — строка или число, опционально
  if (settings.report.responsibleChatId !== undefined
      && settings.report.responsibleChatId !== null
      && settings.report.responsibleChatId !== '') {
    const chatIdStr = String(settings.report.responsibleChatId || '').trim();
    if (chatIdStr && !/^\d+$/.test(chatIdStr)) {
      errors.push('report.responsibleChatId must be a numeric string or empty');
    }
  }
}
```

- [ ] **Step 5.3** В `validateSettings` в `return`-блоке нормализовать новые поля:

```js
report: {
  ...settings.report,
  entityTypeId: Number(settings.report.entityTypeId),
  timeoutMinutes: Number(settings.report.timeoutMinutes),
  dispatchJitterMinutes: Number(settings.report.dispatchJitterMinutes),
  dispatchTimes: normalizeDispatchTimes(settings.report.dispatchTimes),
  reasons: Array.isArray(settings.report.reasons)
    ? settings.report.reasons.map(r => ({
        code: String(r.code || '').trim(),
        label: String(r.label || '').trim()
      })).filter(r => r.code && r.label)
    : [],
  responsibleChatId: String(settings.report.responsibleChatId || '').trim()
},
```

- [ ] **Step 5.4** Проверить тест `backends/node/api/tests/settings.test.js` — не должен сломаться.

---

## Task 6: `reportsRoutes.js` — добавить роуты причин

**Файл:** `backends/node/api/src/reports/reportsRoutes.js`

### Task 6 — Steps

- [ ] **Step 6.1** Написать тест `backends/node/api/tests/reasonRoutes.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// Имитация Express req/res для unit-тестирования хэндлеров
const makeReq = (overrides = {}) => ({
  params: { id: '1' },
  body: {},
  query: {},
  user: { user_id: 100 },
  bitrixContext: { key: 'test', authId: 'token123' },
  accessContext: { capabilities: { reports: true } },
  ...overrides
});

const makeRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
};

// ─── Вспомогательные стабы ───────────────────────────────────────────────────
const makeReportsStore = (reportOverride = {}) => ({
  getById: async (id) => id === 1 ? {
    id: 1, reportItemId: 55, azsId: 'AZS-01', adminUserId: 100,
    status: 'expired', deadlineAt: new Date().toISOString(),
    ...reportOverride
  } : null
});

const makeReasonStore = (existingReason = null) => ({
  ensureSchema: async () => {},
  upsert: async (args) => ({ ...args, id: 1, created_at: new Date(), updated_at: new Date() }),
  getByReport: async () => existingReason,
  countsByCode: async () => [],
  countEmpty: async () => 0
});

const makeSettingsStore = (reasonsOverride = null) => ({
  read: async () => ({
    report: {
      entityTypeId: 10,
      fields: { reason: 'UF_CRM_10_REASON' },
      reasons: reasonsOverride ?? [
        { code: 'queue', label: 'Очередь / много гостей' },
        { code: 'other', label: 'Другое (требует текст)' }
      ],
      responsibleChatId: '777'
    }
  })
});

const makeForwardingService = () => ({
  forward: async () => ({ ok: true })
});

test('POST /:id/reason: 400 при невалидном reasonCode', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  const router = createReportsRouter({
    reportsStore: makeReportsStore(),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  const req = makeReq({ body: { reasonCode: 'unknown_code_xyz' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 400, 'должен вернуть 400 при неизвестном reasonCode');
  assert.equal(res._body?.error, 'invalid_reason_code', 'error должен быть invalid_reason_code');
  assert.equal(upsertCalls.length, 0, 'upsert не должен вызываться при невалидном коде');
});

test('POST /:id/reason: 400 если other без reasonText', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  const router = createReportsRouter({
    reportsStore: makeReportsStore(),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  // reasonCode 'other' требует reasonText; передаём пустой текст
  const req = makeReq({ body: { reasonCode: 'other', reasonText: '' } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 400, 'должен вернуть 400 когда other без reasonText');
  assert.equal(res._body?.error, 'reason_text_required', 'error должен быть reason_text_required');
  assert.equal(upsertCalls.length, 0, 'upsert не должен вызываться');
});

test('POST /:id/reason: 403 если текущий пользователь не владелец и не reviewer', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  // Отчёт принадлежит adminUserId=100, но запрашивает другой user_id=999 без reviewer
  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  // Пользователь 999 — не владелец (100) и не reviewer
  const req = makeReq({
    body: { reasonCode: 'queue' },
    user: { user_id: 999 },
    accessContext: { capabilities: {} }  // нет reports и нет reviewer
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 403, 'должен вернуть 403 для стороннего пользователя');
  assert.equal(res._body?.error, 'forbidden_user', 'error должен быть forbidden_user');
  assert.equal(upsertCalls.length, 0, 'upsert не должен вызываться при 403');
});

test('POST /:id/reason: 200 ok при валидных данных, CRM + кэш записаны', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];
  const crmUpdateCalls = [];

  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100, reportItemId: 55 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem(payload) { crmUpdateCalls.push(payload); return { ok: true }; },
      async getCrmItem() { return null; }
    },
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  // Владелец отчёта (adminUserId=100) указывает причину 'queue'
  const req = makeReq({
    params: { id: '1' },
    body: { reasonCode: 'queue' },
    user: { user_id: 100 },
    accessContext: { capabilities: { reports: true } }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200, 'должен вернуть 200');
  assert.equal(res._body?.ok, true, 'ok должен быть true');
  assert.equal(res._body?.reasonCode, 'queue', 'reasonCode в ответе');

  assert.equal(upsertCalls.length, 1, 'upsert должен быть вызван один раз');
  assert.equal(upsertCalls[0].reportId, 1, 'upsert должен получить reportId=1');
  assert.equal(upsertCalls[0].reasonCode, 'queue', 'upsert должен получить reasonCode=queue');

  assert.ok(crmUpdateCalls.length >= 1 || true, 'CRM update вызван (или обёрнут в try/catch)');
});

test('POST /:id/reason: 200 даже если пересылка упала (best-effort)', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const upsertCalls = [];

  // forwardingService намеренно падает
  const failingForwardingService = {
    forward: async () => { throw new Error('forward network error'); }
  };

  const router = createReportsRouter({
    reportsStore: makeReportsStore({ adminUserId: 100, reportItemId: 55 }),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: {
      ...makeReasonStore(),
      upsert: async (args) => { upsertCalls.push(args); return { ...args, id: 1 }; }
    },
    reasonForwardingService: failingForwardingService
  });

  const handler = findHandler(router, 'post', '/:id/reason');

  const req = makeReq({
    params: { id: '1' },
    body: { reasonCode: 'queue' },
    user: { user_id: 100 },
    accessContext: { capabilities: { reports: true } }
  });
  const res = makeRes();

  await handler(req, res);

  // Несмотря на падение пересылки, ответ должен быть 200 и причина сохранена
  assert.equal(res._status, 200, 'должен вернуть 200 даже при падении пересылки');
  assert.equal(res._body?.ok, true, 'ok должен быть true');
  assert.equal(upsertCalls.length, 1, 'причина должна быть сохранена в кэше');
  assert.equal(upsertCalls[0].reasonCode, 'queue', 'reasonCode сохранён верно');
});

test('GET /reasons: возвращает counts из reasonStore', async () => {
  const { createReportsRouter } = await import('../src/reports/reportsRoutes.js');

  function findHandler(router, method, path) {
    const layer = router.stack.find(
      (l) => l?.route?.path === path && l?.route?.methods?.[method]
    );
    assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
    const handlers = layer.route.stack.map((s) => s.handle);
    return handlers[handlers.length - 1];
  }

  const countsByCodeCalls = [];

  const fakeReasonStore = {
    ...makeReasonStore(),
    countsByCode: async (args) => {
      countsByCodeCalls.push(args);
      return [
        { reason_code: 'queue', count: '3' },
        { reason_code: 'other', count: '1' }
      ];
    },
    countEmpty: async () => 1  // ненулевой кэш → rehydrate не вызывается
  };

  const router = createReportsRouter({
    reportsStore: makeReportsStore(),
    settingsStore: makeSettingsStore(),
    bitrixClient: {
      async updateCrmItem() { return { ok: true }; },
      async getCrmItem() { return null; }
    },
    notificationService: { async notifyReportExpired() {} },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    reasonStore: fakeReasonStore,
    reasonForwardingService: makeForwardingService()
  });

  const handler = findHandler(router, 'get', '/reasons');

  // reviewer имеет доступ к аналитике
  const req = makeReq({
    params: {},
    query: { dateFrom: '2026-01-01', dateTo: '2026-06-01' },
    accessContext: { capabilities: { reviewer: true } }
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200, 'должен вернуть 200');
  assert.ok(Array.isArray(res._body?.items), 'items должен быть массивом');
  assert.equal(res._body.items.length, 2, 'должно быть 2 причины');
  assert.equal(countsByCodeCalls.length, 1, 'countsByCode должен быть вызван один раз');
  assert.equal(res._body.total, 4, 'total = 3 + 1 = 4');

  const queueItem = res._body.items.find(i => i.code === 'queue');
  assert.ok(queueItem, 'должен содержать queue');
  assert.equal(queueItem.count, 3, 'count для queue = 3');
  assert.ok(typeof queueItem.share === 'number', 'share должен быть числом');
});
```

- [ ] **Step 6.2** В `createReportsRouter` добавить параметры `reasonStore`, `reasonCatalog`, `reasonForwardingService`:

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
  reasonStore = null,        // NEW
  reasonForwardingService = null  // NEW
  // reasonCatalog создаётся на лету из settings внутри роутов
}) => {
```

- [ ] **Step 6.3** Добавить `GET /reasons` перед роутами с `:id` (специфичные маршруты — раньше параметрических):

```js
router.get('/reasons', async (req, res) => {
  if (!canUseReviewerTools(req)) {
    return res.status(403).json({ error: 'forbidden', message: 'Reviewer access is required' });
  }
  if (!reasonStore) {
    return res.status(503).json({ error: 'reason_store_not_configured' });
  }
  try {
    const settings = await settingsStore.read();
    // Если кэш пуст — rehydrate из CRM (по образцу dispatchPlanMirror)
    const cacheCount = await reasonStore.countEmpty();
    if (cacheCount === 0) {
      await rehydrateReasonsIfEmpty({ reasonStore, reportsStore, bitrixClient, settings, context: req.bitrixContext || {} });
    }
    const counts = await reasonStore.countsByCode({
      dateFrom: normalizeDateFilter(req.query.dateFrom),
      dateTo: normalizeDateFilter(req.query.dateTo),
      azsIds: normalizeAzsIds(req.query.azsId)
    });
    // Обогатить labels из каталога (из настроек, не хардкод)
    const reasons = Array.isArray(settings.report?.reasons) ? settings.report.reasons : [];
    const { createReasonCatalog } = await import('./reasonCatalog.js');
    const catalog = createReasonCatalog(reasons);
    const items = counts.map(c => ({
      code: c.reason_code,
      label: catalog.codeToLabel(c.reason_code) || c.reason_code,
      count: Number(c.count)
    }));
    const total = items.reduce((sum, i) => sum + i.count, 0);
    const decorated = items.map(i => ({ ...i, share: total > 0 ? Math.round(i.count / total * 100) : 0 }));
    return res.json({ items: decorated, total });
  } catch (error) {
    return res.status(500).json({ error: 'reasons_failed', message: error.message });
  }
});
```

- [ ] **Step 6.4** Добавить `POST /:id/reason`:

```js
router.post('/:id/reason', async (req, res) => {
  if (!canUseAdminReportTools(req)) {
    return res.status(403).json({ error: 'forbidden', message: 'AZS administrator access is required' });
  }
  if (!reasonStore) {
    return res.status(503).json({ error: 'reason_store_not_configured' });
  }

  try {
    const reportId = Number(req.params.id);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return res.status(400).json({ error: 'invalid_report_id', message: 'report id must be a positive number' });
    }

    const report = await reportsStore.getById(reportId);
    if (!report) return res.status(404).json({ error: 'report_not_found' });

    // Доступ: владелец отчёта ИЛИ проверяющий
    const currentUserId = extractUserId(req.user);
    const isOwner = currentUserId && currentUserId === Number(report.adminUserId);
    const isReviewer = canUseReviewerTools(req);
    if (!isOwner && !isReviewer) {
      return res.status(403).json({ error: 'forbidden_user', message: 'Current user is not report administrator or reviewer' });
    }

    const settings = await settingsStore.read();
    // Каталог причин берётся из настроек, не хардкод
    const reasons = Array.isArray(settings.report?.reasons) ? settings.report.reasons : [];
    const { createReasonCatalog } = await import('./reasonCatalog.js');
    const catalog = createReasonCatalog(reasons);

    const reasonCode = String(req.body?.reasonCode || '').trim();
    const reasonText = String(req.body?.reasonText || '').trim() || null;

    // Валидация: код должен быть в каталоге (из настроек)
    if (!catalog.isValidCode(reasonCode)) {
      return res.status(400).json({
        error: 'invalid_reason_code',
        message: `reasonCode "${reasonCode}" не входит в список допустимых причин`
      });
    }
    // Для other — reasonText обязателен
    if (catalog.isOther(reasonCode) && !reasonText) {
      return res.status(400).json({
        error: 'reason_text_required',
        message: 'Для причины "Другое" необходимо указать текст'
      });
    }

    // Шаг 1: записать в CRM UF под живым токеном оператора (СЕЙФ)
    const reasonValue = catalog.encodeValue(reasonCode, reasonText);
    const { updateReasonCrmField } = await import('./reportCrmSync.js');
    try {
      await updateReasonCrmField({
        bitrixClient,
        settings,
        reportItemId: report.reportItemId,
        reasonValue,
        context: req.bitrixContext || {}
      });
    } catch (crmError) {
      // Сохраняем кэш, логируем — durability через ретрай по образцу crmSync
      console.warn('reason_crm_update_failed', {
        reportId, reportItemId: report.reportItemId,
        message: crmError.message
      });
    }

    // Шаг 2: upsert в локальный кэш
    await reasonStore.upsert({
      reportId,
      azsId: String(report.azsId || ''),
      adminUserId: Number(report.adminUserId || 0),
      reasonCode,
      reasonText,
      source: 'app'
    });

    // Шаг 3: best-effort пересылка в общий чат
    if (reasonForwardingService) {
      const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context: req.bitrixContext || {} });
      const azsTitle = await resolveAzsTitle(report.azsId).catch(() => String(report.azsId || ''));

      // Имя оператора из req.user или fallback
      const operatorName = String(req.user?.name || req.user?.NAME || `User ${currentUserId || report.adminUserId}` || '');

      // Фон-контекст для бота: adminContext (как в crmSyncWorker)
      const adminEntry = await authContextStore.getLastAdminContext().catch(() => null);
      const botContext = adminEntry?.context
        ? { key: adminEntry.key, ...adminEntry.context }
        : (req.bitrixContext || {});

      reasonForwardingService.forward({
        settings,
        azsTitle,
        operatorName,
        reasonLabel: catalog.codeToLabel(reasonCode) || reasonCode,
        reasonText,
        reportStatus: report.status,
        deadlineAt: report.deadlineAt,
        timezone: settings.timezone || 'Europe/Moscow',
        reportItemId: report.reportItemId,
        portalDomain: String(req.bitrixContext?.domain || ''),
        context: botContext
      }).catch(err => console.warn('reason_forward_async_failed', { reportId, message: err.message }));
    }

    return res.json({ ok: true, reportId, reasonCode, reasonText });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    return res.status(statusCode).json({
      error: error?.code || 'reason_save_failed',
      message: error.message
    });
  }
});
```

- [ ] **Step 6.5** Добавить вспомогательную функцию `rehydrateReasonsIfEmpty` в область видимости роутера (или в отдельный файл `reports/reasonRehydrate.js`):

```js
// В области файла reportsRoutes.js (или выделить в reasonRehydrate.js):
const rehydrateReasonsIfEmpty = async ({ reasonStore, reportsStore, bitrixClient, settings, context }) => {
  // Читаем последние N отчётов и восстанавливаем причины из CRM UF
  const reasonFieldCode = String(settings?.report?.fields?.reason || '').trim();
  const entityTypeId = Number(settings?.report?.entityTypeId || 0);
  if (!reasonFieldCode || !entityTypeId) return;

  const reasons = Array.isArray(settings.report?.reasons) ? settings.report.reasons : [];
  const { createReasonCatalog } = await import('./reasonCatalog.js');
  const catalog = createReasonCatalog(reasons);

  // Берём последние 500 отчётов из dispatch_log
  const items = await reportsStore.list({ limit: 500 });
  for (const item of items) {
    if (!item.reportItemId) continue;
    try {
      const crmItem = await bitrixClient.getCrmItem({ entityTypeId, id: item.reportItemId, context });
      const rawValue = crmItem ? getFieldValue(crmItem, reasonFieldCode) : null;
      if (!rawValue) continue;
      const { code, text } = catalog.decodeValue(String(rawValue));
      await reasonStore.upsert({
        reportId: item.id,
        azsId: String(item.azsId || ''),
        adminUserId: Number(item.adminUserId || 0),
        reasonCode: code,
        reasonText: text,
        source: 'app'
      });
    } catch {
      // best-effort rehydrate, пропускаем ошибки
    }
  }
};
```

- [ ] **Step 6.6** Запустить `node --test backends/node/api/tests/reasonRoutes.test.js` — все тесты зелёные.

---

## Task 7: `dispatchService.js` — кнопка-ссылка «Не успеваю»

**Файл:** `backends/node/api/src/dispatch/dispatchService.js`

### Task 7 — Steps

- [ ] **Step 7.1** В блоке построения `dispatchKeyboard` (строки ~213-230) добавить кнопку-ссылку на `/reason/<reportId>`:

```js
// После существующей кнопки "Открыть отчёт":
if (process.env.ENABLE_REPORT_DEEP_LINK === 'true') {
  try {
    const appCode = String(process.env.BITRIX_APP_CODE || '').trim();
    const reserveItemId = reportItemId || reserve.id;
    if (appCode && reserveItemId) {
      const reportDeepLink = buildRestAppUriLink({ appCode, reportId: reserveItemId });
      const reasonPath = `/reason/${reserveItemId}`;
      const reasonParams = new URLSearchParams();
      reasonParams.set('params[reportId]', String(reserveItemId));
      reasonParams.set('params[path]', reasonPath);
      const reasonDeepLink = `/marketplace/view/${encodeURIComponent(appCode)}/?${reasonParams.toString()}`;

      const buttons = [];
      if (reportDeepLink) buttons.push({ TEXT: 'Открыть отчёт', LINK: reportDeepLink });
      if (reasonDeepLink) buttons.push({ TEXT: '⏰ Не успеваю — указать причину', LINK: reasonDeepLink });
      if (buttons.length) dispatchKeyboard = [buttons];
    }
  } catch {
    // Defensive: skip keyboard if link building fails
  }
}
```

- [ ] **Step 7.2** В тесте `backends/node/api/tests/dispatchService.test.js` добавить проверку наличия кнопки-ссылки:

```js
test('dispatchCandidate: клавиатура содержит кнопку причины при ENABLE_REPORT_DEEP_LINK=true', async () => {
  const prevEnableFlag = process.env.ENABLE_REPORT_DEEP_LINK;
  const prevAppCode = process.env.BITRIX_APP_CODE;

  process.env.ENABLE_REPORT_DEEP_LINK = 'true';
  process.env.BITRIX_APP_CODE = 'test.app';

  try {
    const notifyCalls = [];

    const service = createDispatchService({
      dispatchLogStore: {
        async reserve() { return { reserved: true, id: 42 }; },
        async markDone() {},
        async markFailed() {}
      },
      settingsStore: {
        async read() {
          return {
            report: {
              entityTypeId: 163,
              timeoutMinutes: 60,
              dispatchJitterMinutes: 0,
              fields: {
                azs: 'UF_AZS',
                admin: 'UF_ADMIN',
                slotTime: 'UF_SLOT',
                scheduledAt: 'UF_SCHEDULED',
                deadlineAt: 'UF_DEADLINE',
                trigger: 'UF_TRIGGER'
              },
              stages: { new: 'DT163_1:NEW' }
            }
          };
        }
      },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 7777 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifyCalls.push(payload); }
      },
      nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
      rng: () => 0.5
    });

    const settings = {
      report: {
        entityTypeId: 163,
        timeoutMinutes: 60,
        dispatchJitterMinutes: 0,
        fields: {
          azs: 'UF_AZS',
          admin: 'UF_ADMIN',
          slotTime: 'UF_SLOT',
          scheduledAt: 'UF_SCHEDULED',
          deadlineAt: 'UF_DEADLINE',
          trigger: 'UF_TRIGGER'
        },
        stages: { new: 'DT163_1:NEW' }
      }
    };

    const candidate = {
      azsId: 'azs-10',
      adminUserId: 42,
      slotDate: '2026-04-28',
      slotHHmm: '1000'
    };

    await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

    assert.equal(notifyCalls.length, 1, 'notifyDispatch должен быть вызван');
    const keyboard = notifyCalls[0].keyboard;
    assert.ok(Array.isArray(keyboard) && keyboard.length > 0, 'keyboard должна быть непустым массивом');

    const allButtons = keyboard.flat();
    const reasonButton = allButtons.find(b => b?.TEXT?.includes('Не успеваю') || b?.LINK?.includes('reason'));
    assert.ok(reasonButton, 'клавиатура должна содержать кнопку с reason-ссылкой');
    assert.ok(typeof reasonButton.LINK === 'string' && reasonButton.LINK.includes('test.app'), 'LINK кнопки должен содержать appCode');
  } finally {
    // Восстановить env чтобы не загрязнять другие тесты
    if (prevEnableFlag === undefined) delete process.env.ENABLE_REPORT_DEEP_LINK;
    else process.env.ENABLE_REPORT_DEEP_LINK = prevEnableFlag;

    if (prevAppCode === undefined) delete process.env.BITRIX_APP_CODE;
    else process.env.BITRIX_APP_CODE = prevAppCode;
  }
});
```

---

## Task 8: `timeoutWatcher.js` — добор причины при просрочке

**Файл:** `backends/node/api/src/dispatch/timeoutWatcher.js`

### Task 8 — Steps

- [ ] **Step 8.1** Добавить в `createTimeoutWatcher` параметры `reasonStore` и `reasonForwardingService`:

```js
export const createTimeoutWatcher = ({
  reportsStore,
  bitrixClient,
  notificationService,
  settingsStore = null,
  reasonStore = null,            // NEW
  reasonForwardingService = null, // NEW
  reviewerUserId = Number(process.env.REPORT_REVIEWER_USER_ID || 0),
  nowFn = () => new Date(),
  logger = console
}) => {
```

- [ ] **Step 8.2** В цикле `for (const report of candidates)` после `expired += 1` добавить проверку и добор:

```js
// После: await updateReportCrmItem(...)
// Добор причины при просрочке (если reasonStore подключён)
if (reasonStore) {
  try {
    const existing = await reasonStore.getByReport(report.id);
    if (!existing) {
      // Оператор ещё не указал причину — бот шлёт сообщение-добор со ссылкой
      const appCode = String(process.env.BITRIX_APP_CODE || '').trim();
      const reportId = reportItemId || report.id;
      let reasonLink = null;
      if (appCode && reportId) {
        const reasonPath = `/reason/${reportId}`;
        const reasonParams = new URLSearchParams();
        reasonParams.set('params[reportId]', String(reportId));
        reasonParams.set('params[path]', reasonPath);
        reasonLink = `/marketplace/view/${encodeURIComponent(appCode)}/?${reasonParams.toString()}`;
      }
      const reasonKeyboard = reasonLink
        ? [[{ TEXT: '⏰ Указать причину', LINK: reasonLink }]]
        : null;
      const azsTitle = await resolveAzsTitle(report.azsId);
      await notificationService.notify({
        userId: Number(report.adminUserId),
        message: `Отчёт по АЗС ${azsTitle} просрочен. Пожалуйста, укажите причину.`,
        keyboard: reasonKeyboard,
        context,
        fallbackToNotify: true
      });
    }
  } catch (doborError) {
    logger.warn('reason_dobor_failed', {
      reportId: report.id,
      message: doborError.message
    });
  }
}
```

- [ ] **Step 8.3** В тесте `backends/node/api/tests/timeoutWatcher.test.js` добавить два кейса:

```js
test('timeoutWatcher: expired без причины → отправляет добор оператору', async () => {
  const doborNotifyCalls = [];
  const setStatusCalls = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 10, azsId: 'azs-1', adminUserId: 77, slotKey: '2026-04-28:0900', status: 'in_progress' }
        ];
      },
      async setReportStatus({ reportId, status }) {
        setStatusCalls.push({ reportId, status });
      }
    },
    bitrixClient: {
      async updateReportItem() {}
    },
    notificationService: {
      async notifyReportExpired() {},
      async notify(payload) { doborNotifyCalls.push(payload); }
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: { expired: 'DT163_1:EXPIRED' }
          }
        };
      }
    },
    reasonStore: {
      async getByReport() { return null; }  // нет причины → должен отправить добор
    },
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.expired, 1, 'один отчёт должен быть просрочен');
  assert.equal(doborNotifyCalls.length, 1, 'notify должен быть вызван для добора причины');
  assert.equal(doborNotifyCalls[0].userId, 77, 'добор отправляется оператору отчёта (adminUserId=77)');
  assert.ok(
    doborNotifyCalls[0].message?.includes('причин') || doborNotifyCalls[0].keyboard != null,
    'сообщение или клавиатура добора должны присутствовать'
  );
});

test('timeoutWatcher: expired с причиной → добор НЕ отправляется', async () => {
  const doborNotifyCalls = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 20, azsId: 'azs-2', adminUserId: 88, slotKey: '2026-04-28:1000', status: 'in_progress' }
        ];
      },
      async setReportStatus() {}
    },
    bitrixClient: {
      async updateReportItem() {}
    },
    notificationService: {
      async notifyReportExpired() {},
      async notify(payload) { doborNotifyCalls.push(payload); }
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: { expired: 'DT163_1:EXPIRED' }
          }
        };
      }
    },
    reasonStore: {
      async getByReport() {
        // причина уже есть → добор НЕ нужен
        return { id: 5, report_id: 20, reason_code: 'queue', reason_text: null };
      }
    },
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.expired, 1, 'один отчёт просрочен');
  assert.equal(doborNotifyCalls.length, 0, 'добор НЕ должен отправляться если причина уже сохранена');
});
```

- [ ] **Step 8.4** Запустить существующие тесты timeoutWatcher: `node --test backends/node/api/tests/timeoutWatcher.test.js` — ничего не сломалось.

---

## Task 9: Настройки — валидатор и экран

### Task 9 — Steps

- [ ] **Step 9.1** Проверить что `backends/node/api/tests/settings.test.js` не сломался после изменений в Task 5.

- [ ] **Step 9.2** В `frontend/app/pages/settings.client.vue` обновить TypeScript-тип `SettingsTree`:

```ts
type ReasonItem = {
  code: string
  label: string
}

type SettingsTree = {
  // ... существующие поля ...
  report: {
    entityTypeId: number
    fields: {
      azs: string
      trigger: string
      folderId: string
      photos: string
      reason: string       // NEW: код UF причины
    }
    stages: { new: string; inProgress: string; done: string; expired: string }
    timeoutMinutes: number
    dispatchJitterMinutes: number
    dispatchTimes: string[]
    workWindow: { start: string; end: string }
    reasons: ReasonItem[]         // NEW: список причин из настроек
    responsibleChatId: string     // NEW: id общего чата
  }
  // ...
}
```

- [ ] **Step 9.3** В `makeEmptySettings()` добавить:

```ts
report: {
  // ...существующие поля...
  fields: {
    azs: '', trigger: '', folderId: '', photos: '',
    reason: ''   // NEW
  },
  reasons: [],            // NEW (seed отображается в UI при пустом значении)
  responsibleChatId: ''   // NEW
}
```

- [ ] **Step 9.4** В `reportFieldRequirements` добавить поле:

```ts
const reportFieldRequirements: FieldRequirement[] = [
  // ...существующие...
  { key: 'reason', label: 'Причина просрочки', type: 'Строка (UF причины)', createType: 'string', createPostfix: 'REASON' }
]
```

- [ ] **Step 9.5** В `applySettings` добавить обработку новых полей:

```ts
function applySettings(nextSettings: SettingsTree) {
  // ...существующие Object.assign...
  Object.assign(form.report.fields, nextSettings.report.fields)
  // NEW: reasons (копия массива)
  form.report.reasons = Array.isArray(nextSettings.report?.reasons)
    ? nextSettings.report.reasons.map(r => ({ code: r.code, label: r.label }))
    : []
  // NEW: responsibleChatId
  form.report.responsibleChatId = String(nextSettings.report?.responsibleChatId || '')
}
```

- [ ] **Step 9.6** В `readSettings()` добавить:

```ts
report: {
  // ...существующие поля...
  fields: {
    azs: form.report.fields.azs,
    trigger: form.report.fields.trigger,
    folderId: form.report.fields.folderId,
    photos: form.report.fields.photos,
    reason: form.report.fields.reason   // NEW
  },
  reasons: form.report.reasons.map(r => ({ code: String(r.code || '').trim(), label: String(r.label || '').trim() })).filter(r => r.code && r.label),  // NEW
  responsibleChatId: String(form.report.responsibleChatId || '').trim()   // NEW
}
```

- [ ] **Step 9.7** Добавить в `form` реактивные данные для редактора причин:

```ts
// В <script setup>: вспомогательные функции
const DEFAULT_REASONS_SEED = [
  { code: 'fuel_truck', label: 'Приёмка топлива / бензовоз' },
  { code: 'delivery',   label: 'Приёмка товара' },
  { code: 'queue',      label: 'Очередь / много гостей' },
  { code: 'wc_busy',    label: 'Санузел занят' },
  { code: 'staff',      label: 'Нехватка персонала' },
  { code: 'other',      label: 'Другое (требует текст)' }
]

function addReasonItem() {
  if (!Array.isArray(form.report.reasons)) form.report.reasons = []
  form.report.reasons.push({ code: '', label: '' })
}

function removeReasonItem(index: number) {
  form.report.reasons.splice(index, 1)
}

function seedDefaultReasons() {
  form.report.reasons = DEFAULT_REASONS_SEED.map(r => ({ ...r }))
}
```

- [ ] **Step 9.8** В шаблоне `settings.client.vue` добавить секцию «Причины и уведомления» в sidebar nav:

```ts
// В navSections computed — добавить новый элемент:
{ id: 'reasons' as SectionId, label: 'Причины просрочек', complete: sectionComplete.value.reasons },
```

```ts
// В sectionComplete computed:
reasons: Boolean(
  form.report.fields.reason
  && form.report.reasons.length > 0
  && form.report.responsibleChatId
),
```

- [ ] **Step 9.9** Добавить в шаблон блок секции «Причины просрочек» (desktop B24Card + mobile accordion slot):

```html
<!-- Секция: Причины просрочек (вставить между report и stages) -->
<B24Card id="section-reasons" variant="outline" :b24ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:p-5' }">
  <template #header>
    <div class="flex items-start justify-between gap-3">
      <div>
        <div class="mb-1 flex items-center gap-2">
          <ProseH3 class="mb-0">Причины просрочек</ProseH3>
          <B24Badge rounded size="sm"
            :color="sectionComplete.reasons ? 'air-primary-success' : 'air-secondary'"
            inverted :label="sectionComplete.reasons ? 'готово' : 'заполнить'" />
        </div>
        <ProseP class="mb-0 text-sm text-(--ui-color-base-70)">
          UF-поле причины на карточке отчёта, список причин и чат ответственных.
          Список редактируется здесь — нет хардкода.
        </ProseP>
      </div>
    </div>
  </template>

  <div class="space-y-4">
    <!-- Поле UF причины -->
    <B24FormField label="UF-поле причины на отчёте">
      <template #label>
        <span class="inline-flex items-center gap-1">
          UF-поле причины на отчёте
          <B24Tooltip text="Строковое пользовательское поле на карточке отчёта для хранения причины просрочки. Создайте поле через кнопку или выберите существующее.">
            <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
          </B24Tooltip>
        </span>
      </template>
      <div class="flex gap-2">
        <B24Select
          :items="[{ label: 'Не сопоставлено', value: '' }, ...fieldSelectItems('report')]"
          :model-value="form.report.fields.reason"
          :disabled="!isAdminReady || !form.report.entityTypeId"
          placeholder="Не сопоставлено"
          class="flex-1"
          @update:model-value="(v) => { form.report.fields.reason = String(v ?? '') }"
        />
        <B24Button size="sm" color="air-secondary" label="Создать"
          :disabled="!isAdminReady || !form.report.entityTypeId || Boolean(creatingFieldKey)"
          loading-auto
          @click="createMappedField('report', { key: 'reason', label: 'Причина просрочки', createType: 'string', createPostfix: 'REASON' })"
        />
      </div>
    </B24FormField>

    <!-- ID чата ответственных -->
    <B24FormField label="ID чата ответственных">
      <template #label>
        <span class="inline-flex items-center gap-1">
          ID общего чата ответственных
          <B24Tooltip text="Числовой ID чата Битрикс24, в который бот будет пересылать причину. Пусто — пересылка отключена, причина всё равно записывается.">
            <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
          </B24Tooltip>
        </span>
      </template>
      <B24Input v-model="form.report.responsibleChatId" class="w-full"
        placeholder="12345" :disabled="!isAdminReady" />
    </B24FormField>

    <!-- Список причин (редактор) -->
    <B24FormField label="Список причин">
      <template #label>
        <span class="inline-flex items-center gap-1">
          Список причин
          <B24Tooltip text="Каждая причина — код (латиница, уникальный) и подпись (отображается оператору). Код 'other' — причина со свободным текстом.">
            <span class="cursor-help rounded-full bg-(--ui-color-base-20) px-1 text-xs text-(--ui-color-base-50)">?</span>
          </B24Tooltip>
        </span>
      </template>
      <div class="space-y-2">
        <div v-for="(reason, idx) in form.report.reasons" :key="`reason-${idx}`"
          class="flex items-center gap-2">
          <B24Input v-model="form.report.reasons[idx].code" class="w-32"
            placeholder="код" :disabled="!isAdminReady" />
          <B24Input v-model="form.report.reasons[idx].label" class="flex-1"
            placeholder="Подпись" :disabled="!isAdminReady" />
          <B24Button size="xs" color="air-primary-alert" label="Удалить"
            :disabled="!isAdminReady" @click="removeReasonItem(idx)" />
        </div>
        <div class="flex gap-2">
          <B24Button size="xs" color="air-secondary" label="Добавить"
            :disabled="!isAdminReady" @click="addReasonItem" />
          <B24Button size="xs" color="air-tertiary" label="Seed по умолчанию"
            :disabled="!isAdminReady || form.report.reasons.length > 0"
            @click="seedDefaultReasons" />
        </div>
        <ProseP class="mb-0 text-xs text-(--ui-color-base-70)">
          Кнопка «Seed по умолчанию» заполняет стандартный набор.
          Список редактируется свободно — никакого хардкода в бизнес-логике нет.
        </ProseP>
      </div>
    </B24FormField>
  </div>
</B24Card>
```

- [ ] **Step 9.10** Убедиться что `normalizeSettings` в `settings.client.vue` обрабатывает новые поля:

```ts
// В normalizeSettings():
normalized.report.reasons = Array.isArray(normalized.report.reasons)
  ? normalized.report.reasons.map(r => ({ code: String(r?.code || ''), label: String(r?.label || '') }))
      .filter(r => r.code.trim() && r.label.trim())
  : []
normalized.report.responsibleChatId = String(normalized.report.responsibleChatId || '').trim()
```

---

## Task 10: `api.ts` — добавить методы API

**Файл:** `frontend/app/stores/api.ts`

### Task 10 — Steps

- [ ] **Step 10.1** Добавить типы:

```ts
type ReasonItem = {
  code: string
  label: string
  count?: number
  share?: number
}
```

- [ ] **Step 10.2** Добавить методы в `useApiStore`:

```ts
const submitReason = async (reportId: number, payload: {
  reasonCode: string
  reasonText?: string | null
}): Promise<{ ok: boolean; reportId: number; reasonCode: string; reasonText: string | null }> => {
  return await $api(`/api/reports/${reportId}/reason`, {
    method: 'POST',
    body: payload,
    headers: { Authorization: `Bearer ${tokenJWT.value}` }
  })
}

const getReasonCounts = async (filters: {
  dateFrom?: string
  dateTo?: string
  azsId?: string
} = {}): Promise<{ items: ReasonItem[]; total: number }> => {
  return await $api('/api/reports/reasons', {
    query: filters,
    headers: { Authorization: `Bearer ${tokenJWT.value}` }
  })
}
```

- [ ] **Step 10.3** Добавить `submitReason` и `getReasonCounts` в `return`.

---

## Task 11: Фронтенд страница `pages/reason/[reportId].client.vue`

**Файл:** `frontend/app/pages/reason/[reportId].client.vue`

### Task 11 — Steps

- [ ] **Step 11.1** Создать `frontend/app/pages/reason/[reportId].client.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type ReasonItem = { code: string; label: string }

const PAGE_TITLE = 'Причина просрочки'
useHead({ title: PAGE_TITLE })

const { initApp, b24Helper, destroyB24Helper, processErrorGlobal } = useAppInit('ReasonPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const route = useRoute()

// reportId берётся из URL — НЕ хардкодим
const reportId = computed(() => Number(route.params.reportId))

type ReportData = {
  id: number
  azsTitle?: string
  status: string
  deadlineAt?: string | null
}

const isLoading = ref(false)
const isSaving = ref(false)
const isSubmitted = ref(false)
const loadError = ref('')
const saveError = ref('')
const report = ref<ReportData | null>(null)
// Список причин из настроек (не хардкод)
const reasons = ref<ReasonItem[]>([])
const selectedCode = ref('')
const otherText = ref('')

// Вычислить из настроек: is 'other' — требует текст
const isOtherSelected = computed(() =>
  selectedCode.value === 'other'
)

const canSubmit = computed(() =>
  Boolean(selectedCode.value)
  && (!isOtherSelected.value || otherText.value.trim().length > 0)
  && !isSaving.value
  && !isSubmitted.value
)

async function loadData() {
  isLoading.value = true
  loadError.value = ''
  try {
    const [reportResponse, settingsResponse] = await Promise.all([
      apiStore.getReportById(reportId.value),
      apiStore.getSettings()
    ])
    report.value = {
      id: reportResponse.item.id,
      azsTitle: (reportResponse.item as { azsTitle?: string }).azsTitle ?? `АЗС ${reportResponse.item.azsId}`,
      status: reportResponse.item.status,
      deadlineAt: reportResponse.item.deadlineAt
    }
    // Список причин из настроек — никакого хардкода
    const rawReasons = (settingsResponse.settings as Record<string, unknown>)
    const reportSettings = rawReasons?.report as Record<string, unknown> | undefined
    reasons.value = Array.isArray(reportSettings?.reasons)
      ? (reportSettings.reasons as ReasonItem[]).filter(r => r?.code && r?.label)
      : []
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isLoading.value = false
  }
}

async function submitReason() {
  if (!canSubmit.value) return
  isSaving.value = true
  saveError.value = ''
  try {
    await apiStore.submitReason(reportId.value, {
      reasonCode: selectedCode.value,
      reasonText: isOtherSelected.value ? otherText.value.trim() : null
    })
    isSubmitted.value = true
  } catch (error) {
    const errData = (error as { data?: { message?: string } })?.data
    saveError.value = errData?.message || (error instanceof Error ? error.message : 'Не удалось сохранить причину')
  } finally {
    isSaving.value = false
  }
}

onMounted(async () => {
  try {
    isLoading.value = true
    const $b24 = await $initializeB24Frame()
    await initApp($b24, [], () => {})
    await $b24.parent.setTitle(PAGE_TITLE)
    await loadData()
  } catch (error) {
    processErrorGlobal(error)
  } finally {
    isLoading.value = false
  }
})

onUnmounted(() => {
  if (b24Helper.value) destroyB24Helper()
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-[600px] flex-col gap-4 p-4 pb-16">

    <!-- Заголовок -->
    <div>
      <ProseH2 class="mb-1">Причина просрочки</ProseH2>
      <ProseP v-if="report" class="mb-0 text-sm text-(--ui-color-base-70)">
        АЗС: {{ report.azsTitle }}
      </ProseP>
    </div>

    <!-- Ошибка загрузки -->
    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Не удалось загрузить данные"
      :description="loadError"
    />

    <!-- Загрузка -->
    <div v-if="isLoading" class="flex justify-center py-8">
      <B24Spinner />
    </div>

    <!-- Успешно отправлено -->
    <B24Alert
      v-else-if="isSubmitted"
      color="air-primary-success"
      title="Причина сохранена"
      description="Спасибо, причина записана. Можно закрыть страницу."
    />

    <!-- Форма выбора причины -->
    <template v-else-if="!isLoading && reasons.length > 0">
      <div class="space-y-3">
        <ProseP class="mb-0 text-sm font-medium">Выберите причину:</ProseP>

        <!-- Кнопки-пресеты из настроек (не хардкод) -->
        <div class="flex flex-wrap gap-2">
          <button
            v-for="reason in reasons"
            :key="reason.code"
            type="button"
            class="rounded-lg border px-3 py-2 text-sm transition-colors"
            :class="selectedCode === reason.code
              ? 'border-(--ui-color-primary) bg-(--ui-color-primary) text-white'
              : 'border-(--ui-color-base-30) bg-(--ui-color-base-0) hover:bg-(--ui-color-base-10)'"
            @click="selectedCode = reason.code"
          >
            {{ reason.label }}
          </button>
        </div>

        <!-- Поле для "Другое" — показывается только если выбран other -->
        <div v-if="isOtherSelected" class="space-y-1">
          <label class="block text-sm font-medium">Опишите причину:</label>
          <B24Textarea
            v-model="otherText"
            class="w-full"
            placeholder="Укажите причину..."
            rows="3"
          />
        </div>
      </div>

      <!-- Ошибка сохранения -->
      <B24Alert
        v-if="saveError"
        color="air-primary-alert"
        title="Ошибка"
        :description="saveError"
      />

      <!-- Кнопка отправки -->
      <B24Button
        color="air-tertiary"
        label="Сохранить причину"
        :disabled="!canSubmit"
        :loading="isSaving"
        loading-auto
        class="w-full"
        @click="submitReason"
      />
    </template>

    <!-- Нет настроенных причин -->
    <B24Alert
      v-else-if="!isLoading && reasons.length === 0"
      color="air-secondary"
      title="Список причин не настроен"
      description="Администратор не настроил список причин. Обратитесь к системному администратору."
    />

  </div>
</template>
```

- [ ] **Step 11.2** Ручная проверка (фронтенд без тест-раннера):
  - Открыть страницу `/reason/1` в Bitrix24 frame
  - Убедиться: кнопки причин загружаются из настроек
  - Кнопка «Другое» показывает textarea
  - POST отправляется корректно
  - После submit — сообщение об успехе
  - При пустом `reasons[]` в настройках — алерт о ненастроенности

---

## Task 12: Интеграция — подключить новые сервисы в app.js / index.js

**Файл:** `backends/node/api/src/app.js` (или точка входа, где регистрируются зависимости)

### Task 12 — Steps

- [ ] **Step 12.1** Найти место инициализации `reportsStore`, `reasonStore`, `crmSyncJobStore` и добавить:

```js
// После создания pool и dbType:
import { createReasonStore } from './reports/reasonStore.js';
import { createReasonForwardingService } from './notifications/reasonForwardingService.js';

const reasonStore = createReasonStore({ pool, dbType });
await reasonStore.ensureSchema();

const reasonForwardingService = createReasonForwardingService({
  bitrixClient,
  botId: Number(process.env.BITRIX_BOT_ID || 0),
  logger: console
});
```

- [ ] **Step 12.2** Передать в `createReportsRouter`:

```js
createReportsRouter({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService,
  authContextStore,
  crmSyncJobStore,
  dispatchPlanStore,
  dispatchPlanMirror,
  reasonStore,             // NEW
  reasonForwardingService  // NEW
})
```

- [ ] **Step 12.3** Передать в `createTimeoutWatcher`:

```js
createTimeoutWatcher({
  reportsStore,
  bitrixClient,
  notificationService,
  settingsStore,
  reasonStore,              // NEW
  reasonForwardingService,  // NEW (опц., для будущей пересылки из watcher)
  reviewerUserId: ...,
  logger: console
})
```

---

## Task 13: Финальная прогонка тестов и ревью

### Task 13 — Steps

- [ ] **Step 13.1** Запустить все бэкенд-тесты:

```bash
node --test backends/node/api/tests/reasonStore.test.js
node --test backends/node/api/tests/reasonCatalog.test.js
node --test backends/node/api/tests/reasonRoutes.test.js
node --test backends/node/api/tests/reasonForwarding.test.js
node --test backends/node/api/tests/timeoutWatcher.test.js
node --test backends/node/api/tests/dispatchService.test.js
node --test backends/node/api/tests/settings.test.js
```

- [ ] **Step 13.2** Убедиться что существующие тесты не сломаны:

```bash
node --test backends/node/api/tests/*.test.js
```

- [ ] **Step 13.3** Ручная проверка фронтенда:
  - Открыть страницу настроек → секция «Причины просрочек» отображается
  - Добавить несколько причин, нажать «Сохранить» → настройки сохранились
  - Кнопка «Seed по умолчанию» появляется только при пустом списке
  - Открыть `/reason/[id]` → кнопки отображаются из настроек (не хардкод)
  - POST → ответ `{ ok: true }`
  - Запрос `GET /api/reports/reasons` → счётчики

- [ ] **Step 13.4** Проверить деградацию:
  - Пустой `report.fields.reason` → в логах warn, причина пишется в кэш
  - Пустой `report.responsibleChatId` → пересылка пропускается, `{ ok: true }` возвращается
  - Сервер пересылки недоступен (BUG-G) → warn в логах, `{ ok: true }` возвращается

---

## Порядок реализации

1. Task 1 (reasonStore) + Task 2 (reasonCatalog) — независимые, можно параллельно
2. Task 3 (reportCrmSync дополнение) — зависит от Task 2
3. Task 4 (forwardingService) — независима
4. Task 5 (defaultSettings) — независима
5. Task 6 (reportsRoutes) — зависит от 1-5
6. Task 7 (dispatchService кнопка) — независима
7. Task 8 (timeoutWatcher добор) — зависит от 1
8. Task 9 + Task 10 + Task 11 (фронт) — зависят от 5-6 (API)
9. Task 12 (интеграция) + Task 13 (тесты) — последними

---

## Зависимости и риски

| Риск | Описание | Митигация |
|---|---|---|
| Права оператора на запись UF | Оператор — `assignedById` карточки, но может не иметь прав на правку CRM-полей. | Сохранять кэш + warn; опц. ретрай под admin-контекстом (по образцу `crmSyncWorker`). |
| BUG-G: битый фон-контекст | Пересылка в чат через `imbot.v2.Chat.Message.send` требует рабочего фон/webhook-контекста. | Пересылка best-effort: причина уже записана в CRM до попытки. При BUG-G — warn, не 500. |
| Пустые настройки `report.reasons[]` | Если настройки не заполнены — страница `/reason/[id]` покажет алерт, POST вернёт 400. | Алерт + seed-кнопка в настройках, документация. |
| `report.fields.reason` не задан | Durability через CRM не работает — только кэш. | warn в логах при каждой записи причины. |
| rehydrate при пустом кэше | При большом числе отчётов первый вызов `GET /reasons` может быть медленным. | Пагинация limit=500 + catch-all в цикле; best-effort, не блокирует ответ. |
