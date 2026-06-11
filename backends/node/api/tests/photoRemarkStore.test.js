import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRemarkStore } from '../src/reports/photoRemarkStore.js';

// ---------------------------------------------------------------------------
// Fake PG pool
// ---------------------------------------------------------------------------

const createFakePgPool = () => {
  const remarks = [];
  const photos = [];
  let seq = 0;

  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) {
        return { rows: [] };
      }

      // INSERT photo_remark_photo (must come BEFORE the remark insert check)
      if (text.startsWith('INSERT INTO photo_remark_photo')) {
        photos.push({ remark_id: params[0], report_id: params[1], photo_code: params[2] });
        return { rows: [] };
      }

      // INSERT remark (header only — no _photo suffix)
      if (text.startsWith('INSERT INTO photo_remark')) {
        seq += 1;
        const row = {
          id: seq,
          created_at: new Date(),
          azs_id: params[0], azs_title: params[1],
          recipient_role: params[2], recipient_user_id: params[3], recipient_name: params[4],
          message: params[5], sender_user_id: params[6], sender_name: params[7],
          delivery_status: 'sent', delivery_error: null
        };
        remarks.push(row);
        return { rows: [row] };
      }

      // UPDATE delivery
      if (text.startsWith('UPDATE photo_remark SET delivery_status')) {
        const row = remarks.find((r) => r.id === params[2]);
        if (row) { row.delivery_status = params[0]; row.delivery_error = params[1]; }
        return { rows: [] };
      }

      // SELECT single remark by id
      if (text.includes('FROM photo_remark WHERE id =')) {
        return { rows: remarks.filter((r) => r.id === params[0]) };
      }

      // SELECT photos by remark_id (ANY — used by list)
      if (text.includes('FROM photo_remark_photo WHERE remark_id = ANY')) {
        const ids = params[0];
        return { rows: photos.filter((p) => ids.includes(Number(p.remark_id))) };
      }

      // SELECT photos by single remark_id (used by getById)
      if (text.includes('FROM photo_remark_photo WHERE remark_id')) {
        return { rows: photos.filter((p) => Number(p.remark_id) === Number(params[0])) };
      }

      // SELECT list (complex query with ORDER BY)
      if (text.includes('FROM photo_remark') && text.includes('ORDER BY created_at DESC')) {
        let rows = [...remarks];

        // date filters — just use all rows for simplicity in the fake
        // azsId filter
        if (text.includes('azs_id = ANY')) {
          const ids = params.find((p) => Array.isArray(p));
          if (ids) rows = rows.filter((r) => ids.includes(r.azs_id));
        } else if (text.includes('azs_id =')) {
          const idx = params.findIndex((p) => typeof p === 'string' && !p.match(/^\d{4}-/));
          if (idx >= 0) rows = rows.filter((r) => r.azs_id === params[idx]);
        }

        rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id);
        // limit is last param
        const lim = Number(params[params.length - 1]) || 51;
        return { rows: rows.slice(0, lim) };
      }

      return { rows: [] };
    }
  };
};

// ---------------------------------------------------------------------------
// Fake MySQL pool
// ---------------------------------------------------------------------------

const createFakeMysqlPool = () => {
  const remarks = [];
  const photos = [];
  let seq = 0;

  return {
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (text.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }];

      if (text.startsWith('INSERT INTO photo_remark') && !text.includes('photo_remark_photo')) {
        seq += 1;
        const row = {
          id: seq,
          created_at: new Date(),
          azs_id: params[0], azs_title: params[1],
          recipient_role: params[2], recipient_user_id: params[3], recipient_name: params[4],
          message: params[5], sender_user_id: params[6], sender_name: params[7],
          delivery_status: 'sent', delivery_error: null
        };
        remarks.push(row);
        return [{ insertId: seq }];
      }

      if (text.startsWith('INSERT IGNORE INTO photo_remark_photo')) {
        photos.push({ remark_id: params[0], report_id: params[1], photo_code: params[2] });
        return [{ affectedRows: 1 }];
      }

      if (text.startsWith('SELECT * FROM photo_remark WHERE id = ?')) {
        return [remarks.filter((r) => r.id === params[0])];
      }

      if (text.startsWith('UPDATE photo_remark SET delivery_status')) {
        const row = remarks.find((r) => r.id === params[2]);
        if (row) { row.delivery_status = params[0]; row.delivery_error = params[1]; }
        return [{ affectedRows: 1 }];
      }

      if (text.includes('FROM photo_remark_photo WHERE remark_id IN')) {
        const ids = params.map(Number);
        return [photos.filter((p) => ids.includes(Number(p.remark_id)))];
      }

      if (text.includes('FROM photo_remark_photo WHERE remark_id = ?')) {
        return [photos.filter((p) => Number(p.remark_id) === Number(params[0]))];
      }

      if (text.includes('FROM photo_remark') && text.includes('ORDER BY created_at DESC')) {
        let rows = [...remarks];
        rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id);
        const lim = Number(params[params.length - 1]) || 51;
        return [rows.slice(0, lim)];
      }

      return [[]];
    }
  };
};

// ---------------------------------------------------------------------------
// PG Tests
// ---------------------------------------------------------------------------

test('PG: ensureSchema runs without error', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await assert.doesNotReject(() => store.ensureSchema());
});

test('PG: insertRemark returns remark with id and correct fields', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const remark = await store.insertRemark({
    azsId: '42',
    azsTitle: 'АЗС Тест',
    recipientRole: 'manager',
    recipientUserId: 7,
    recipientName: 'Иван',
    message: 'Замечание',
    senderUserId: 3,
    senderName: 'Проверяющий',
    photos: [{ reportId: 10, photoCode: 'front' }, { reportId: 10, photoCode: 'side' }]
  });
  assert.equal(remark.azsId, '42');
  assert.equal(remark.recipientRole, 'manager');
  assert.equal(remark.deliveryStatus, 'sent');
  assert.ok(Number.isFinite(remark.id));
});

test('PG: markDelivery updates status and error', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const remark = await store.insertRemark({ azsId: '1', recipientRole: 'admin', message: 'test' });
  await store.markDelivery(remark.id, 'failed', 'network error');

  // read back from the pool's raw rows
  const raw = pool.query.rows ?? [];
  // verify via getById mock behaviour
  const found = await store.getById(remark.id);
  assert.equal(found.deliveryStatus, 'failed');
  assert.equal(found.deliveryError, 'network error');
});

test('PG: getById returns null for missing id', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const result = await store.getById(999);
  assert.equal(result, null);
});

test('PG: getById returns remark with photos array', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const inserted = await store.insertRemark({
    azsId: '5', recipientRole: 'admin', message: 'msg',
    photos: [{ reportId: 20, photoCode: 'back' }]
  });
  const found = await store.getById(inserted.id);
  assert.ok(found, 'should find remark');
  assert.ok(Array.isArray(found.photos));
  assert.equal(found.photos.length, 1);
  assert.equal(found.photos[0].photoCode, 'back');
});

test('PG: list returns items with nextCursor when over limit', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  // insert 3 remarks
  for (let i = 0; i < 3; i++) {
    await store.insertRemark({ azsId: '10', recipientRole: 'manager', message: `m${i}` });
  }
  const { items, nextCursor } = await store.list({ azsIds: ['10'], limit: 2 });
  assert.equal(items.length, 2);
  assert.ok(nextCursor, 'should have cursor when more items exist');
});

test('PG: list with no items returns empty array and null cursor', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const { items, nextCursor } = await store.list({ azsIds: ['999'] });
  assert.deepEqual(items, []);
  assert.equal(nextCursor, null);
});

// ---------------------------------------------------------------------------
// MySQL Tests
// ---------------------------------------------------------------------------

test('MySQL: ensureSchema runs without error', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await assert.doesNotReject(() => store.ensureSchema());
});

test('MySQL: insertRemark returns remark with id', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  const remark = await store.insertRemark({
    azsId: '55', recipientRole: 'admin', message: 'check',
    photos: [{ reportId: 100, photoCode: 'top' }]
  });
  assert.ok(Number.isFinite(remark.id) && remark.id > 0);
  assert.equal(remark.azsId, '55');
});

test('MySQL: markDelivery and getById reflects updated delivery status', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  const remark = await store.insertRemark({ azsId: '2', recipientRole: 'manager', message: 'test' });
  await store.markDelivery(remark.id, 'failed', 'timeout');
  const found = await store.getById(remark.id);
  assert.equal(found.deliveryStatus, 'failed');
  assert.equal(found.deliveryError, 'timeout');
});

test('MySQL: list returns items', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  await store.insertRemark({ azsId: '7', recipientRole: 'manager', message: 'a' });
  await store.insertRemark({ azsId: '7', recipientRole: 'admin', message: 'b' });
  const { items } = await store.list({ azsIds: ['7'], limit: 10 });
  assert.ok(items.length >= 1);
});

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

test('createPhotoRemarkStore throws when pool is missing', () => {
  assert.throws(() => createPhotoRemarkStore({ dbType: 'postgresql' }), /pool is required/);
});
