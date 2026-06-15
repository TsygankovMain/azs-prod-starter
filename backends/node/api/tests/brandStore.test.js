import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseBrandStore } from '../src/brands/databaseBrandStore.js';

// ---------------------------------------------------------------------------
// Fake PG pool — in-memory implementation
// ---------------------------------------------------------------------------
const createFakePgPool = () => {
  const brands = [];
  const brandAzs = [];
  let brandSeq = 0;
  let azsSeq = 0;

  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      // DDL — no-op
      if (
        text.startsWith('CREATE TABLE') ||
        text.startsWith('CREATE UNIQUE INDEX') ||
        text.startsWith('CREATE INDEX')
      ) {
        return { rows: [] };
      }

      // INSERT INTO brand
      if (/^INSERT INTO brand\s/i.test(text) && !/azs/i.test(text)) {
        brandSeq += 1;
        const now = new Date();
        const row = {
          id: brandSeq,
          name: params[0],
          disk_folder_id: null,
          disk_folder_path: null,
          external_link: null,
          external_link_updated_at: null,
          created_at: now,
          updated_at: now
        };
        brands.push(row);
        return { rows: [row] };
      }

      // INSERT INTO brand_azs (single azs)
      if (/^INSERT INTO brand_azs/i.test(text) && !/ON CONFLICT.*DO UPDATE/i.test(text)) {
        // upsert-style insert without ON CONFLICT — simple add
        const brandId = Number(params[0]);
        const azsId = String(params[1]);
        // UNIQUE constraint simulation: azs_id must be unique
        const existing = brandAzs.find((r) => r.azs_id === azsId);
        if (existing) {
          const err = new Error(`duplicate key value violates unique constraint "brand_azs_azs_id_key"`);
          err.code = '23505';
          throw err;
        }
        azsSeq += 1;
        const row = { id: azsSeq, brand_id: brandId, azs_id: azsId, created_at: new Date() };
        brandAzs.push(row);
        return { rows: [row] };
      }

      // INSERT INTO brand_azs ... ON CONFLICT (azs_id) DO UPDATE SET brand_id
      // This is the "transfer" pattern used by setBrandAzs / addAzs
      if (/^INSERT INTO brand_azs/i.test(text) && /ON CONFLICT.*DO UPDATE/i.test(text)) {
        const brandId = Number(params[0]);
        const azsId = String(params[1]);
        const existing = brandAzs.find((r) => r.azs_id === azsId);
        if (existing) {
          existing.brand_id = brandId;
          return { rows: [existing] };
        }
        azsSeq += 1;
        const row = { id: azsSeq, brand_id: brandId, azs_id: azsId, created_at: new Date() };
        brandAzs.push(row);
        return { rows: [row] };
      }

      // SELECT brand by id
      if (/SELECT .* FROM brand WHERE id = /i.test(text)) {
        const id = Number(params[0]);
        const row = brands.find((b) => b.id === id) || null;
        return { rows: row ? [row] : [] };
      }

      // SELECT all brands
      if (/SELECT .* FROM brand ORDER BY/i.test(text) || /SELECT .* FROM brand$/i.test(text)) {
        return { rows: [...brands].sort((a, b) => a.id - b.id) };
      }

      // UPDATE brand
      if (/^UPDATE brand SET/i.test(text)) {
        // Generic UPDATE — parse which fields are being updated by position
        // We detect by looking at SQL keywords in the text
        const idParam = params[params.length - 1];
        const id = Number(idParam);
        const row = brands.find((b) => b.id === id);
        if (!row) return { rows: [] };

        if (/disk_folder_id/i.test(text)) {
          row.disk_folder_id = params[0] != null ? Number(params[0]) : null;
          if (params[1] !== undefined && !/NOW\(\)/i.test(String(params[1]))) {
            row.disk_folder_path = params[1] || null;
          }
        } else if (/external_link/i.test(text)) {
          row.external_link = params[0] || null;
          row.external_link_updated_at = new Date();
        } else if (/\bname\b/i.test(text)) {
          // updateBrand — first param is name
          row.name = params[0];
        }
        row.updated_at = new Date();
        return { rows: [row] };
      }

      // DELETE FROM brand WHERE id
      if (/^DELETE FROM brand WHERE id = /i.test(text)) {
        const id = Number(params[0]);
        const idx = brands.findIndex((b) => b.id === id);
        if (idx >= 0) brands.splice(idx, 1);
        // Also cascade delete brand_azs
        const azsIdxToRemove = [];
        brandAzs.forEach((r, i) => { if (r.brand_id === id) azsIdxToRemove.push(i); });
        azsIdxToRemove.reverse().forEach((i) => brandAzs.splice(i, 1));
        return { rows: [] };
      }

      // DELETE FROM brand_azs WHERE brand_id = $1 AND azs_id = $2
      if (/^DELETE FROM brand_azs WHERE brand_id = .* AND azs_id/i.test(text)) {
        const brandId = Number(params[0]);
        const azsId = String(params[1]);
        const idx = brandAzs.findIndex((r) => r.brand_id === brandId && r.azs_id === azsId);
        if (idx >= 0) brandAzs.splice(idx, 1);
        return { rows: [] };
      }

      // DELETE FROM brand_azs WHERE brand_id = $1 (clear all for brand)
      if (/^DELETE FROM brand_azs WHERE brand_id = /i.test(text) && !/azs_id/i.test(text)) {
        const brandId = Number(params[0]);
        const idxs = [];
        brandAzs.forEach((r, i) => { if (r.brand_id === brandId) idxs.push(i); });
        idxs.reverse().forEach((i) => brandAzs.splice(i, 1));
        return { rows: [] };
      }

      // SELECT brand_azs WHERE brand_id
      if (/SELECT .* FROM brand_azs WHERE brand_id = /i.test(text)) {
        const brandId = Number(params[0]);
        return { rows: brandAzs.filter((r) => r.brand_id === brandId) };
      }

      // SELECT brand_azs WHERE azs_id (for getBrandByAzsId)
      if (/SELECT .* FROM brand_azs.*WHERE.*azs_id = /i.test(text)) {
        const azsId = String(params[0]);
        const azsRow = brandAzs.find((r) => r.azs_id === azsId);
        if (!azsRow) return { rows: [] };
        const brandRow = brands.find((b) => b.id === azsRow.brand_id);
        return { rows: brandRow ? [{ ...azsRow, ...brandRow }] : [] };
      }

      return { rows: [] };
    }
  };
};

// ---------------------------------------------------------------------------
// Fake MySQL pool — in-memory implementation
// ---------------------------------------------------------------------------
const createFakeMysqlPool = () => {
  const brands = [];
  const brandAzs = [];
  let brandSeq = 0;
  let azsSeq = 0;

  return {
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      // DDL
      if (text.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }];

      // INSERT INTO brand
      if (/^INSERT INTO brand\s/i.test(text) && !/azs/i.test(text)) {
        brandSeq += 1;
        const now = new Date();
        const row = {
          id: brandSeq,
          name: params[0],
          disk_folder_id: null,
          disk_folder_path: null,
          external_link: null,
          external_link_updated_at: null,
          created_at: now,
          updated_at: now
        };
        brands.push(row);
        return [{ insertId: brandSeq }];
      }

      // INSERT INTO brand_azs ... ON DUPLICATE KEY UPDATE
      if (/^INSERT INTO brand_azs/i.test(text) && /ON DUPLICATE KEY UPDATE/i.test(text)) {
        const brandId = Number(params[0]);
        const azsId = String(params[1]);
        const existing = brandAzs.find((r) => r.azs_id === azsId);
        if (existing) {
          existing.brand_id = brandId;
          return [{ affectedRows: 2 }];
        }
        azsSeq += 1;
        brandAzs.push({ id: azsSeq, brand_id: brandId, azs_id: azsId, created_at: new Date() });
        return [{ affectedRows: 1, insertId: azsSeq }];
      }

      // SELECT brand by id
      if (/SELECT .* FROM brand WHERE id = /i.test(text)) {
        const id = Number(params[0]);
        const row = brands.find((b) => b.id === id) || null;
        return [row ? [row] : []];
      }

      // SELECT all brands
      if (/SELECT .* FROM brand ORDER BY/i.test(text) || /SELECT .* FROM `?brand`?$/i.test(text)) {
        return [[...brands].sort((a, b) => a.id - b.id)];
      }

      // UPDATE brand
      if (/^UPDATE brand SET/i.test(text)) {
        const idParam = params[params.length - 1];
        const id = Number(idParam);
        const row = brands.find((b) => b.id === id);
        if (!row) return [{ affectedRows: 0 }];

        if (/disk_folder_id/i.test(text)) {
          row.disk_folder_id = params[0] != null ? Number(params[0]) : null;
          if (params[1] !== undefined) row.disk_folder_path = params[1] || null;
        } else if (/external_link/i.test(text)) {
          row.external_link = params[0] || null;
          row.external_link_updated_at = new Date();
        } else if (/\bname\b/i.test(text)) {
          row.name = params[0];
        }
        row.updated_at = new Date();
        return [{ affectedRows: 1 }];
      }

      // SELECT after INSERT brand (MySQL needs SELECT to get full row)
      if (/SELECT .* FROM brand WHERE id = \?/i.test(text)) {
        const id = Number(params[0]);
        const row = brands.find((b) => b.id === id) || null;
        return [row ? [row] : []];
      }

      // DELETE FROM brand WHERE id
      if (/^DELETE FROM brand WHERE id = /i.test(text)) {
        const id = Number(params[0]);
        const idx = brands.findIndex((b) => b.id === id);
        if (idx >= 0) brands.splice(idx, 1);
        const azsIdxToRemove = [];
        brandAzs.forEach((r, i) => { if (r.brand_id === id) azsIdxToRemove.push(i); });
        azsIdxToRemove.reverse().forEach((i) => brandAzs.splice(i, 1));
        return [{ affectedRows: 1 }];
      }

      // DELETE FROM brand_azs WHERE brand_id AND azs_id
      if (/^DELETE FROM brand_azs WHERE brand_id = .* AND azs_id/i.test(text)) {
        const brandId = Number(params[0]);
        const azsId = String(params[1]);
        const idx = brandAzs.findIndex((r) => r.brand_id === brandId && r.azs_id === azsId);
        if (idx >= 0) brandAzs.splice(idx, 1);
        return [{ affectedRows: 1 }];
      }

      // DELETE FROM brand_azs WHERE brand_id only
      if (/^DELETE FROM brand_azs WHERE brand_id = /i.test(text) && !/azs_id/i.test(text)) {
        const brandId = Number(params[0]);
        const idxs = [];
        brandAzs.forEach((r, i) => { if (r.brand_id === brandId) idxs.push(i); });
        idxs.reverse().forEach((i) => brandAzs.splice(i, 1));
        return [{ affectedRows: idxs.length }];
      }

      // SELECT brand_azs WHERE brand_id
      if (/SELECT .* FROM brand_azs WHERE brand_id = /i.test(text)) {
        const brandId = Number(params[0]);
        return [brandAzs.filter((r) => r.brand_id === brandId)];
      }

      // SELECT brand_azs JOIN brand WHERE azs_id
      if (/SELECT .* FROM brand_azs.*WHERE.*azs_id = /i.test(text)) {
        const azsId = String(params[0]);
        const azsRow = brandAzs.find((r) => r.azs_id === azsId);
        if (!azsRow) return [[]];
        const brandRow = brands.find((b) => b.id === azsRow.brand_id);
        return [brandRow ? [{ ...azsRow, ...brandRow }] : []];
      }

      return [[]];
    }
  };
};

// ===========================================================================
// PostgreSQL tests
// ===========================================================================

test('brandStore PG: ensureSchema creates brand and brand_azs tables', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await assert.doesNotReject(() => store.ensureSchema());
});

test('brandStore PG: createBrand returns brand with id and name', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'ГПН Москва' });
  assert.ok(brand, 'brand должен вернуться');
  assert.ok(Number.isFinite(brand.id) && brand.id > 0, 'id должен быть числом');
  assert.equal(brand.name, 'ГПН Москва');
});

test('brandStore PG: getBrand returns brand by id', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const created = await store.createBrand({ name: 'Лукойл' });
  const found = await store.getBrand(created.id);
  assert.ok(found, 'getBrand должен вернуть бренд');
  assert.equal(found.name, 'Лукойл');
  assert.equal(found.id, created.id);
});

test('brandStore PG: getBrand returns null for unknown id', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const result = await store.getBrand(9999);
  assert.equal(result, null);
});

test('brandStore PG: listBrands returns all brands', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  await store.createBrand({ name: 'Бренд А' });
  await store.createBrand({ name: 'Бренд Б' });
  const list = await store.listBrands();
  assert.equal(list.length, 2);
  assert.ok(list.some((b) => b.name === 'Бренд А'));
  assert.ok(list.some((b) => b.name === 'Бренд Б'));
});

test('brandStore PG: listBrands returns empty array when no brands', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const list = await store.listBrands();
  assert.deepEqual(list, []);
});

test('brandStore PG: updateBrand changes name', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const created = await store.createBrand({ name: 'Старое имя' });
  await store.updateBrand(created.id, { name: 'Новое имя' });
  const found = await store.getBrand(created.id);
  assert.equal(found.name, 'Новое имя');
});

test('brandStore PG: deleteBrand removes brand', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const created = await store.createBrand({ name: 'Временный' });
  await store.deleteBrand(created.id);
  const found = await store.getBrand(created.id);
  assert.equal(found, null);
});

test('brandStore PG: addAzs links azs to brand', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Роснефть' });
  await store.addAzs(brand.id, 'AZS-01');

  const azsList = await store.listAzsForBrand(brand.id);
  assert.equal(azsList.length, 1);
  assert.equal(azsList[0], 'AZS-01');
});

test('brandStore PG: removeAzs unlinks azs from brand', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Роснефть' });
  await store.addAzs(brand.id, 'AZS-01');
  await store.addAzs(brand.id, 'AZS-02');
  await store.removeAzs(brand.id, 'AZS-01');

  const azsList = await store.listAzsForBrand(brand.id);
  assert.equal(azsList.length, 1);
  assert.equal(azsList[0], 'AZS-02');
});

test('brandStore PG: getBrandByAzsId returns brand for linked azs', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'ГПН Юг' });
  await store.addAzs(brand.id, 'AZS-42');

  const found = await store.getBrandByAzsId('AZS-42');
  assert.ok(found, 'должен найти бренд');
  assert.equal(found.id, brand.id);
  assert.equal(found.name, 'ГПН Юг');
});

test('brandStore PG: getBrandByAzsId returns null for unlinked azs', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const result = await store.getBrandByAzsId('AZS-UNKNOWN');
  assert.equal(result, null);
});

// UNIQUE invariant: одна АЗС = один бренд
test('brandStore PG: addAzs transfers azs to new brand (UNIQUE invariant)', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand1 = await store.createBrand({ name: 'Бренд 1' });
  const brand2 = await store.createBrand({ name: 'Бренд 2' });

  await store.addAzs(brand1.id, 'AZS-99');
  // Повторное добавление той же АЗС в другой бренд — должно перенести
  await store.addAzs(brand2.id, 'AZS-99');

  // АЗС теперь в brand2
  const found = await store.getBrandByAzsId('AZS-99');
  assert.ok(found, 'АЗС должна быть в каком-то бренде');
  assert.equal(found.id, brand2.id, 'АЗС должна перейти в новый бренд');

  // brand1 больше не содержит эту АЗС
  const azsForBrand1 = await store.listAzsForBrand(brand1.id);
  assert.ok(!azsForBrand1.includes('AZS-99'), 'brand1 не должен содержать AZS-99');
});

test('brandStore PG: setBrandAzs устанавливает полный список АЗС для бренда', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Татнефть' });
  await store.setBrandAzs(brand.id, ['AZS-01', 'AZS-02', 'AZS-03']);

  const azsList = await store.listAzsForBrand(brand.id);
  assert.equal(azsList.length, 3);
  assert.ok(azsList.includes('AZS-01'));
  assert.ok(azsList.includes('AZS-03'));
});

test('brandStore PG: setBrandAzs заменяет предыдущий список', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Сургутнефтегаз' });
  await store.setBrandAzs(brand.id, ['AZS-10', 'AZS-11']);
  await store.setBrandAzs(brand.id, ['AZS-20']); // заменяем

  const azsList = await store.listAzsForBrand(brand.id);
  assert.equal(azsList.length, 1);
  assert.equal(azsList[0], 'AZS-20');
  assert.ok(!azsList.includes('AZS-10'), 'старые АЗС должны быть удалены');
});

test('brandStore PG: setBrandDiskFolder сохраняет folderId в бренде', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Диск-бренд' });
  await store.setBrandDiskFolder(brand.id, 123456, '/AZS-Photo-Reports/ГПН-Москва');

  const found = await store.getBrand(brand.id);
  assert.equal(Number(found.disk_folder_id), 123456);
  assert.equal(found.disk_folder_path, '/AZS-Photo-Reports/ГПН-Москва');
});

test('brandStore PG: setBrandExternalLink сохраняет ссылку в бренде', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Ссылка-бренд' });
  await store.setBrandExternalLink(brand.id, 'https://disk.bitrix24.ru/public/...');

  const found = await store.getBrand(brand.id);
  assert.equal(found.external_link, 'https://disk.bitrix24.ru/public/...');
  assert.ok(found.external_link_updated_at, 'external_link_updated_at должен быть заполнен');
});

test('brandStore PG: deleteBrand также удаляет привязанные АЗС (cascade)', async () => {
  const pool = createFakePgPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'postgresql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'Удаляемый' });
  await store.addAzs(brand.id, 'AZS-DEL-1');
  await store.addAzs(brand.id, 'AZS-DEL-2');

  await store.deleteBrand(brand.id);

  // После удаления бренда АЗС не должны числиться ни в каком бренде
  const found1 = await store.getBrandByAzsId('AZS-DEL-1');
  const found2 = await store.getBrandByAzsId('AZS-DEL-2');
  assert.equal(found1, null);
  assert.equal(found2, null);
});

test('brandStore: throws when pool is missing', () => {
  assert.throws(
    () => createDatabaseBrandStore({}),
    /pool is required/i
  );
});

// ===========================================================================
// MySQL tests
// ===========================================================================

test('brandStore MySQL: ensureSchema creates tables', async () => {
  const pool = createFakeMysqlPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'mysql' });
  await assert.doesNotReject(() => store.ensureSchema());
});

test('brandStore MySQL: createBrand returns brand with id and name', async () => {
  const pool = createFakeMysqlPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'MySQL Бренд' });
  assert.ok(brand, 'brand должен вернуться');
  assert.ok(Number.isFinite(brand.id) && brand.id > 0);
  assert.equal(brand.name, 'MySQL Бренд');
});

test('brandStore MySQL: addAzs transfers azs to new brand (UNIQUE invariant)', async () => {
  const pool = createFakeMysqlPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();

  const brand1 = await store.createBrand({ name: 'MySQL Бренд 1' });
  const brand2 = await store.createBrand({ name: 'MySQL Бренд 2' });

  await store.addAzs(brand1.id, 'AZS-M1');
  await store.addAzs(brand2.id, 'AZS-M1'); // перенос

  const found = await store.getBrandByAzsId('AZS-M1');
  assert.ok(found);
  assert.equal(found.id, brand2.id, 'АЗС должна перейти в brand2');
});

test('brandStore MySQL: getBrandByAzsId returns null for unknown azs', async () => {
  const pool = createFakeMysqlPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();

  const result = await store.getBrandByAzsId('AZS-UNKNOWN');
  assert.equal(result, null);
});

test('brandStore MySQL: listAzsForBrand returns correct list', async () => {
  const pool = createFakeMysqlPool();
  const store = createDatabaseBrandStore({ pool, dbType: 'mysql' });
  await store.ensureSchema();

  const brand = await store.createBrand({ name: 'MySQL Роснефть' });
  await store.addAzs(brand.id, 'AZS-R1');
  await store.addAzs(brand.id, 'AZS-R2');

  const list = await store.listAzsForBrand(brand.id);
  assert.equal(list.length, 2);
  assert.ok(list.includes('AZS-R1'));
  assert.ok(list.includes('AZS-R2'));
});
