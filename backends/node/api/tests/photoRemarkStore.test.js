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

      // Idempotent ALTER TABLE migrations — no-op in fake
      if (text.startsWith('ALTER TABLE')) {
        return { rows: [] };
      }

      // INSERT photo_remark_photo (must come BEFORE the remark insert check)
      // UX-2: params are [remark_id, report_id, photo_code, comment] (delivery_status in SQL literal)
      if (text.startsWith('INSERT INTO photo_remark_photo')) {
        photos.push({
          remark_id: params[0], report_id: params[1], photo_code: params[2],
          comment: params[3] ?? '',
          delivery_status: 'pending', delivery_error: null
        });
        return { rows: [] };
      }

      // INSERT remark (header only — no _photo suffix)
      // UX-2: params = [azsId, azsTitle, recipientRole, recipientUserId, recipientName,
      //                  senderUserId, senderName]  (no top-level message)
      if (text.startsWith('INSERT INTO photo_remark')) {
        seq += 1;
        const row = {
          id: seq,
          created_at: new Date(),
          azs_id: params[0], azs_title: params[1],
          recipient_role: params[2], recipient_user_id: params[3], recipient_name: params[4],
          sender_user_id: params[5], sender_name: params[6],
          delivery_status: 'sent', delivery_error: null
        };
        remarks.push(row);
        return { rows: [row] };
      }

      // UPDATE per-photo delivery status
      if (text.includes('UPDATE photo_remark_photo')) {
        // params: [status, error, remarkId, reportId, photoCode]
        const ph = photos.find((p) =>
          Number(p.remark_id) === Number(params[2]) &&
          Number(p.report_id) === Number(params[3]) &&
          p.photo_code === params[4]
        );
        if (ph) { ph.delivery_status = params[0]; ph.delivery_error = params[1]; }
        return { rows: [] };
      }

      // UPDATE delivery (remark-level)
      if (text.startsWith('UPDATE photo_remark SET delivery_status')) {
        const row = remarks.find((r) => r.id === params[2]);
        if (row) { row.delivery_status = params[0]; row.delivery_error = params[1]; }
        return { rows: [] };
      }

      // SELECT single remark by id
      if (text.includes('FROM photo_remark WHERE id =')) {
        return { rows: remarks.filter((r) => r.id === params[0]) };
      }

      // SELECT single photo row (getPhotoRow)
      if (text.includes('FROM photo_remark_photo') && text.includes('AND report_id') && text.includes('AND photo_code')) {
        const found = photos.find((p) =>
          Number(p.remark_id) === Number(params[0]) &&
          Number(p.report_id) === Number(params[1]) &&
          p.photo_code === params[2]
        );
        return { rows: found ? [found] : [] };
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

      // Idempotent migration guards: information_schema check
      if (text.includes('FROM information_schema.COLUMNS')) {
        // Simulate column not existing so migration proceeds (no-op in fake ALTER)
        return [[{ cnt: 0 }]];
      }

      // ALTER TABLE — no-op in fake
      if (text.startsWith('ALTER TABLE')) return [{ affectedRows: 0 }];

      // INSERT remark (no _photo suffix)
      // UX-2: params = [azsId, azsTitle, recipientRole, recipientUserId, recipientName,
      //                  senderUserId, senderName]  (no top-level message)
      if (text.startsWith('INSERT INTO photo_remark') && !text.includes('photo_remark_photo')) {
        seq += 1;
        const row = {
          id: seq,
          created_at: new Date(),
          azs_id: params[0], azs_title: params[1],
          recipient_role: params[2], recipient_user_id: params[3], recipient_name: params[4],
          sender_user_id: params[5], sender_name: params[6],
          delivery_status: 'sent', delivery_error: null
        };
        remarks.push(row);
        return [{ insertId: seq }];
      }

      // INSERT IGNORE photo_remark_photo
      // UX-2: params = [remark_id, report_id, photo_code, comment]
      if (text.startsWith('INSERT IGNORE INTO photo_remark_photo')) {
        photos.push({
          remark_id: params[0], report_id: params[1], photo_code: params[2],
          comment: params[3] ?? '',
          delivery_status: 'pending', delivery_error: null
        });
        return [{ affectedRows: 1 }];
      }

      if (text.startsWith('SELECT * FROM photo_remark WHERE id = ?')) {
        return [remarks.filter((r) => r.id === params[0])];
      }

      // UPDATE per-photo delivery status
      if (text.includes('UPDATE photo_remark_photo')) {
        // params: [status, error, remarkId, reportId, photoCode]
        const ph = photos.find((p) =>
          Number(p.remark_id) === Number(params[2]) &&
          Number(p.report_id) === Number(params[3]) &&
          p.photo_code === params[4]
        );
        if (ph) { ph.delivery_status = params[0]; ph.delivery_error = params[1]; }
        return [{ affectedRows: 1 }];
      }

      // UPDATE remark-level delivery
      if (text.startsWith('UPDATE photo_remark SET delivery_status')) {
        const row = remarks.find((r) => r.id === params[2]);
        if (row) { row.delivery_status = params[0]; row.delivery_error = params[1]; }
        return [{ affectedRows: 1 }];
      }

      // SELECT single photo row (getPhotoRow)
      if (text.includes('FROM photo_remark_photo') && text.includes('AND report_id') && text.includes('AND photo_code')) {
        const found = photos.find((p) =>
          Number(p.remark_id) === Number(params[0]) &&
          Number(p.report_id) === Number(params[1]) &&
          p.photo_code === params[2]
        );
        return [found ? [found] : []];
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
// UX-2: Per-photo comment + per-photo delivery status — PG
// ---------------------------------------------------------------------------

test('PG UX-2: insertRemark stores per-photo comment', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const inserted = await store.insertRemark({
    azsId: '42', recipientRole: 'manager',
    photos: [
      { reportId: 10, photoCode: 'front', comment: 'Грязное стекло' },
      { reportId: 10, photoCode: 'side', comment: 'Сломан насос' }
    ]
  });
  const found = await store.getById(inserted.id);
  assert.ok(found, 'remark found');
  assert.equal(found.photos.length, 2);
  const frontPhoto = found.photos.find((p) => p.photoCode === 'front');
  assert.ok(frontPhoto, 'front photo found');
  assert.equal(frontPhoto.comment, 'Грязное стекло', 'per-photo comment stored');
  const sidePhoto = found.photos.find((p) => p.photoCode === 'side');
  assert.equal(sidePhoto.comment, 'Сломан насос', 'second photo comment stored');
});

test('PG UX-2: markPhotoDelivery updates per-photo status', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const inserted = await store.insertRemark({
    azsId: '42', recipientRole: 'manager',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'Тест' }]
  });
  await store.markPhotoDelivery(inserted.id, 10, 'front', 'failed', 'network timeout');
  const photo = await store.getPhotoRow(inserted.id, 10, 'front');
  assert.ok(photo, 'photo row found');
  assert.equal(photo.deliveryStatus, 'failed');
  assert.equal(photo.deliveryError, 'network timeout');
});

test('PG UX-2: getPhotoRow returns null for missing photo', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const result = await store.getPhotoRow(999, 1, 'nonexistent');
  assert.equal(result, null);
});

test('PG UX-2: list returns per-photo comment + status in photos array', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.insertRemark({
    azsId: '77', recipientRole: 'admin',
    photos: [
      { reportId: 5, photoCode: 'a', comment: 'Комм A' },
      { reportId: 5, photoCode: 'b', comment: 'Комм B' }
    ]
  });
  const { items } = await store.list({ azsIds: ['77'], limit: 10 });
  assert.equal(items.length, 1);
  const ph = items[0].photos.find((p) => p.photoCode === 'a');
  assert.equal(ph.comment, 'Комм A', 'comment present in list');
  assert.ok('deliveryStatus' in ph, 'deliveryStatus present per photo in list');
});

// ---------------------------------------------------------------------------
// UX-2: Per-photo comment + per-photo delivery status — MySQL
// ---------------------------------------------------------------------------

test('MySQL UX-2: insertRemark stores per-photo comment', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  const inserted = await store.insertRemark({
    azsId: '55', recipientRole: 'admin',
    photos: [
      { reportId: 20, photoCode: 'top', comment: 'Лужа масла' }
    ]
  });
  const found = await store.getById(inserted.id);
  assert.ok(found, 'remark found');
  const topPhoto = found.photos.find((p) => p.photoCode === 'top');
  assert.equal(topPhoto.comment, 'Лужа масла');
});

test('MySQL UX-2: markPhotoDelivery updates per-photo status', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  const inserted = await store.insertRemark({
    azsId: '55', recipientRole: 'admin',
    photos: [{ reportId: 20, photoCode: 'top', comment: 'Test' }]
  });
  await store.markPhotoDelivery(inserted.id, 20, 'top', 'sent', null);
  const photo = await store.getPhotoRow(inserted.id, 20, 'top');
  assert.ok(photo, 'photo row found');
  assert.equal(photo.deliveryStatus, 'sent');
  assert.equal(photo.deliveryError, null);
});

// ---------------------------------------------------------------------------
// FEED-2 / BE-3: migration idempotency for recipient_user_id + recipient_name
// ---------------------------------------------------------------------------

test('PG FEED-2: ensureSchema is idempotent — repeated call does not throw', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  // Call twice — must not throw on the second run (ADD COLUMN IF NOT EXISTS)
  await assert.doesNotReject(() => store.ensureSchema());
  await assert.doesNotReject(() => store.ensureSchema());
});

test('PG FEED-2: insertRemark with recipientType=user stores recipient_user_id + recipient_name', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  const remark = await store.insertRemark({
    azsId: '42',
    azsTitle: 'АЗС Тест',
    recipientRole: 'user',
    recipientUserId: 77,
    recipientName: 'Иван Петров',
    senderUserId: 3, senderName: 'Ревизор',
    photos: [{ reportId: 10, photoCode: 'front', comment: 'test' }]
  });
  assert.equal(remark.recipientUserId, 77, 'recipientUserId stored');
  assert.equal(remark.recipientName, 'Иван Петров', 'recipientName stored');
  assert.equal(remark.recipientRole, 'user', 'recipientRole=user stored');
  // getById round-trip
  const found = await store.getById(remark.id);
  assert.equal(found.recipientUserId, 77, 'recipientUserId via getById');
  assert.equal(found.recipientName, 'Иван Петров', 'recipientName via getById');
});

test('PG FEED-2: list returns recipientName for user-type remarks', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  await store.insertRemark({
    azsId: '55',
    recipientRole: 'user',
    recipientUserId: 99,
    recipientName: 'Светлана Тузова',
    photos: [{ reportId: 5, photoCode: 'a', comment: 'ok' }]
  });
  const { items } = await store.list({ azsIds: ['55'], limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].recipientUserId, 99);
  assert.equal(items[0].recipientName, 'Светлана Тузова');
});

test('MySQL FEED-2: ensureSchema is idempotent — repeated call does not throw', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await assert.doesNotReject(() => store.ensureSchema());
  await assert.doesNotReject(() => store.ensureSchema());
});

test('MySQL FEED-2: insertRemark with recipientType=user stores recipient_user_id + recipient_name', async () => {
  const pool = createFakeMysqlPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();
  const remark = await store.insertRemark({
    azsId: '77',
    recipientRole: 'user',
    recipientUserId: 88,
    recipientName: 'Мальцева К.',
    photos: [{ reportId: 20, photoCode: 'top', comment: 'ok' }]
  });
  assert.equal(remark.recipientUserId, 88, 'recipientUserId stored');
  assert.equal(remark.recipientName, 'Мальцева К.', 'recipientName stored');
  // getById round-trip
  const found = await store.getById(remark.id);
  assert.equal(found.recipientUserId, 88, 'recipientUserId via getById');
  assert.equal(found.recipientName, 'Мальцева К.', 'recipientName via getById');
});

test('PG FEED-2: old records without recipient_user_id read back without error', async () => {
  const pool = createFakePgPool();
  const store = createPhotoRemarkStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();
  // Insert an "old" record without recipientUserId/recipientName (simulates pre-FEED2 records)
  const remark = await store.insertRemark({
    azsId: '1', recipientRole: 'manager',
    // No recipientUserId, no recipientName
    photos: [{ reportId: 1, photoCode: 'p', comment: 'old style' }]
  });
  const found = await store.getById(remark.id);
  assert.ok(found, 'old record readable');
  assert.equal(found.recipientUserId, null, 'recipientUserId is null for old records');
  assert.equal(found.recipientName, null, 'recipientName is null for old records');
});

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

test('createPhotoRemarkStore throws when pool is missing', () => {
  assert.throws(() => createPhotoRemarkStore({ dbType: 'postgresql' }), /pool is required/);
});
