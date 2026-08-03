import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoFeedRouter } from '../src/reports/photoFeedRoutes.js';
import { createReportsStore } from '../src/reports/reportsStore.js';

// ---------------------------------------------------------------------------
// Task 9 — «публикуется»: без этой плашки проверяющий, открыв отчёт в окне
// между «приняли байты» и «дошло до Битрикса» (~час на весь парк при живом
// портале), видит пустой/битый тайл и решает, что оператор не сдал смену.
//
// Три состояния report_photo.publish_state:
//   accepted  — байты у нас, в Битрикс ещё не отправлены (нормально, пройдёт)
//   published — файл в Битриксе (обычное фото, плашка не нужна)
//   failed    — само не доедет никогда (квота Диска кончилась, папка
//               удалена, нет прав) — нужен человек, и это НЕ «публикуется»
//
// Тесты бьют по трём слоям, чтобы мутация была реально поймана, а не просто
// «зелёная строка»:
//   1. route  — /feed действительно кладёт publishState в JSON-ответ
//   2. store  — SELECT реально просит publish_state (и Postgres, и MySQL),
//               и toFeedItemViewModel реально его мапит
//   3. SQL    — publish_state НЕ используется как фильтр видимости
//               (иначе accepted/failed отвалятся из ленты — это и есть
//               «выглядит отсутствующим»)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Route-level helpers (тот же паттерн, что в photoFeed.test.js)
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    _headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p)   { this._payload = p; return p; },
    setHeader(k, v) { this._headers[k] = v; },
    send(b)   { this._body = b; }
  };
}

function makeReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: {},
    ...overrides
  };
}

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      const methodHandlers = layer.route.stack.filter(
        (l) => !method || l.method === method.toLowerCase() || !l.method
      );
      return methodHandlers[0]?.handle || null;
    }
  }
  return null;
}

const baseStubDeps = {
  settingsStore: {
    async read() {
      return {
        azs: { entityTypeId: 145, fields: { admin: 'UF_CRM_1_123', manager: '' } },
        photoType: { entityTypeId: 200 }
      };
    }
  },
  bitrixClient: {
    async listCrmItems() { return []; },
    async getCrmItem() { return null; },
    async callMethod() { return null; }
  },
  getAdminContext: async () => ({ authId: 'admin-token', domain: 'test.bitrix24.ru' })
};

// ---------------------------------------------------------------------------
// 1. Route: /feed кладёт publishState в ответ (ровно как задано в брифе)
// ---------------------------------------------------------------------------

test('фотолента отдаёт publishState для каждого фото', async () => {
  const deps = {
    ...baseStubDeps,
    reportsStore: {
      async listPhotosFeed() {
        return {
          items: [
            { reportId: 10, azsId: '42', azsTitle: null, photoCode: 'front', exifAt: null, uploadedAt: '2026-06-11T10:00:00.000Z', photoRowId: 1, remark: null, publishState: 'published' },
            { reportId: 11, azsId: '42', azsTitle: null, photoCode: 'back', exifAt: null, uploadedAt: '2026-06-11T10:05:00.000Z', photoRowId: 2, remark: null, publishState: 'accepted' },
            { reportId: 12, azsId: '42', azsTitle: null, photoCode: 'side', exifAt: null, uploadedAt: '2026-06-11T10:10:00.000Z', photoRowId: 3, remark: null, publishState: 'failed' }
          ],
          nextCursor: null
        };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.items.length, 3);
  for (const item of res._payload.items) {
    assert.ok(
      ['accepted', 'published', 'failed'].includes(item.publishState),
      `у фото ${item.photoCode} нет валидного publishState: ${item.publishState}`
    );
  }
});

test('принятое, но не опубликованное фото не выглядит отсутствующим', async () => {
  // Элемент присутствует в ленте с publishState='accepted', а не пропущен —
  // это и есть «не выглядит отсутствующим»: ни один фильтр по publish_state
  // не должен вырезать его из items.
  const deps = {
    ...baseStubDeps,
    reportsStore: {
      async listPhotosFeed() {
        return {
          items: [
            { reportId: 20, azsId: '77', azsTitle: null, photoCode: 'front', exifAt: null, uploadedAt: '2026-06-11T11:00:00.000Z', photoRowId: 5, remark: null, publishState: 'accepted' }
          ],
          nextCursor: null
        };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.items.length, 1, 'принятое фото должно остаться в ленте');
  assert.equal(res._payload.items[0].publishState, 'accepted');
});

test('фотолента отдаёт publishState=failed отдельно от accepted — проверяющий должен уметь их различить', async () => {
  const deps = {
    ...baseStubDeps,
    reportsStore: {
      async listPhotosFeed() {
        return {
          items: [
            { reportId: 30, azsId: '77', azsTitle: null, photoCode: 'front', exifAt: null, uploadedAt: '2026-06-11T11:00:00.000Z', photoRowId: 6, remark: null, publishState: 'failed' }
          ],
          nextCursor: null
        };
      }
    }
  };
  const router = createPhotoFeedRouter(deps);
  const handler = getHandler(router, 'get', '/feed');
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._payload.items.length, 1, 'фото с ошибкой публикации тоже должно остаться в ленте');
  assert.equal(res._payload.items[0].publishState, 'failed');
  assert.notEqual(res._payload.items[0].publishState, 'accepted',
    'failed и accepted — разные состояния, их нельзя схлопывать в одну плашку "публикуется"');
});

// ---------------------------------------------------------------------------
// 2. Store: SELECT реально просит publish_state, и view-model реально маппит
//    (без этого route-тесты выше зелёные при полностью фейковом сторе, а
//    прод молчит — это и есть декоративный тест, который бриф запрещает)
// ---------------------------------------------------------------------------

const feedRowFixture = (overrides = {}) => ({
  photo_row_id: 1,
  report_id: 10,
  photo_code: 'front',
  exif_at: null,
  uploaded_at: new Date('2026-06-11T10:00:00.000Z'),
  azs_id: '42',
  azs_title: null,
  remark_id: null,
  remark_created_at: null,
  remark_recipient_name: null,
  remark_message: null,
  remark_sender_name: null,
  publish_state: 'accepted',
  ...overrides
});

const makeFakePostgresPool = (rows) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows, rowCount: rows.length };
    }
  };
};

const makeFakeMysqlPool = (rows) => {
  const queries = [];
  return {
    queries,
    async execute(sql, params) {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return [rows];
    }
  };
};

test('Postgres: listPhotosFeed запрашивает publish_state в SELECT', async () => {
  const pool = makeFakePostgresPool([feedRowFixture()]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.listPhotosFeed({});
  const sql = pool.queries[0].sql;
  assert.match(sql, /SELECT[\s\S]*rp\.publish_state[\s\S]*FROM report_photo/,
    'без publish_state в SELECT store не может знать состояние публикации строки');
});

test('Postgres: listPhotosFeed не фильтрует по publish_state — accepted/failed не исчезают из ленты', async () => {
  const pool = makeFakePostgresPool([feedRowFixture()]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  await store.listPhotosFeed({});
  const sql = pool.queries[0].sql;
  // publish_state должен встречаться ровно один раз — в SELECT. Инструмент —
  // не поиск WHERE вообще (внутри LATERAL для remark есть свой легитимный
  // WHERE prp.report_id=..., это не про видимость фото), а прямой запрет на
  // publish_state рядом с оператором сравнения где бы то ни было в тексте.
  assert.ok(!/publish_state\s*(=|<>|!=|in\s*\()/i.test(sql),
    'publish_state не должен быть предикатом фильтра — иначе accepted/failed пропадут из ленты, и это и есть баг "выглядит отсутствующим"');
});

test('Postgres: listPhotosFeed маппит publishState для accepted/published/failed', async () => {
  for (const state of ['accepted', 'published', 'failed']) {
    const pool = makeFakePostgresPool([feedRowFixture({ publish_state: state })]);
    const store = createReportsStore({ pool, dbType: 'postgres' });
    const { items } = await store.listPhotosFeed({});
    assert.equal(items.length, 1);
    assert.equal(items[0].publishState, state, `строка с publish_state='${state}' должна дать publishState='${state}'`);
  }
});

test('Postgres: отсутствующий publish_state в строке не ломает ответ — дефолт published', async () => {
  // Соответствует ALTER TABLE ... DEFAULT 'published' (ensurePhotoSchema):
  // строка без явного publish_state трактуется как уже опубликованная, а не
  // зависает вечно с меткой "публикуется".
  const row = feedRowFixture();
  delete row.publish_state;
  const pool = makeFakePostgresPool([row]);
  const store = createReportsStore({ pool, dbType: 'postgres' });
  const { items } = await store.listPhotosFeed({});
  assert.equal(items[0].publishState, 'published');
});

test('MySQL: listPhotosFeed запрашивает publish_state в SELECT', async () => {
  const pool = makeFakeMysqlPool([feedRowFixture()]);
  const store = createReportsStore({ pool, dbType: 'mysql' });
  await store.listPhotosFeed({});
  const sql = pool.queries[0].sql;
  assert.match(sql, /SELECT[\s\S]*rp\.publish_state[\s\S]*FROM report_photo/);
});

test('MySQL: listPhotosFeed маппит publishState для accepted/published/failed', async () => {
  for (const state of ['accepted', 'published', 'failed']) {
    const pool = makeFakeMysqlPool([feedRowFixture({ publish_state: state })]);
    const store = createReportsStore({ pool, dbType: 'mysql' });
    const { items } = await store.listPhotosFeed({});
    assert.equal(items.length, 1);
    assert.equal(items[0].publishState, state);
  }
});

// ---------------------------------------------------------------------------
// 3. Интеграция: реальный store (фейковый pool) + реальный router — конец в
//    конец, без единого фейкового listPhotosFeed на пути запроса.
// ---------------------------------------------------------------------------

test('интеграция: GET /feed через реальный reportsStore реально отдаёт publishState в JSON', async () => {
  const pool = makeFakePostgresPool([
    feedRowFixture({ report_id: 40, photo_code: 'front', publish_state: 'accepted' })
  ]);
  const reportsStore = createReportsStore({ pool, dbType: 'postgres' });
  const router = createPhotoFeedRouter({ ...baseStubDeps, reportsStore });
  const handler = getHandler(router, 'get', '/feed');
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.items.length, 1);
  assert.equal(res._payload.items[0].publishState, 'accepted');
});
