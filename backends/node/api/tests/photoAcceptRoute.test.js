import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter, readRequiredPhotos } from '../src/reports/reportsRoutes.js';

// ---------------------------------------------------------------------------
// Приём фото не имеет права упасть из-за Битрикса. Ни при каких условиях.
//
// Три уровня получения списка требуемых фото, строго в этом порядке:
//   1. report_local_state.required_photo_codes (наша БД) — обычный случай.
//   2. requiredPhotosCache (модульный кэш в памяти, Task 1) — колонка пуста,
//      кэш прогрет.
//   3. ничего не известно локально — фото ПРИНИМАЕТСЯ на непроверенный слот
//      (slot_verified=false), проверку выполнит воркер при публикации.
//
// Каждый тест ниже использует СВОЙ уникальный azsId/portalKey, чтобы не
// делить состояние модульного синглтона requiredPhotosCache (он живёт на
// процесс, а не на тест) — иначе прогрев кэша в одном тесте тихо испортил бы
// сценарий "кэш пуст" в другом.
// ---------------------------------------------------------------------------

const SETTINGS = {
  azs: { entityTypeId: 145, fields: { photoSet: 'UF_PHOTO_SET' } },
  photoType: { entityTypeId: 1112 },
  report: {
    entityTypeId: 163,
    fields: { folderId: 'UF_FOLDER', photos: 'UF_PHOTOS' },
    stages: { inProgress: 'DT163_1:IN_PROGRESS' }
  },
  disk: { rootFolderId: 0, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' }
};

// bitrixClient, который бросает на ЛЮБОМ методе (в т.ч. на простом доступе к
// вложенному свойству вроде diskApi) — это и есть проверка "подсунь клиента,
// который бросает на любом методе, и убедись, что фото всё равно принято".
// Proxy ловит методы, которых мы могли не предусмотреть явно.
const makeThrowingBitrixClient = () => {
  const state = { calls: 0 };
  const client = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return (...args) => {
        state.calls += 1;
        throw new Error(
          `bitrixClient.${String(prop)}() must not be called — приём фото обязан пережить недоступность портала`
        );
      };
    }
  });
  return { client, state };
};

// Рабочий bitrixClient — используется ТОЛЬКО там, где Битрикс по сюжету жив
// (прогрев кэша через readRequiredPhotos напрямую, открытие карточки отчёта).
const makeWorkingBitrixClient = () => {
  const state = { calls: 0 };
  const client = {
    async getCrmItem({ entityTypeId, id }) {
      state.calls += 1;
      if (entityTypeId === SETTINGS.azs.entityTypeId) {
        return { id, title: `АЗС ${id}`, UF_PHOTO_SET: [42, 43] };
      }
      if (entityTypeId === SETTINGS.photoType.entityTypeId) {
        return { id, title: `Тип ${id}` };
      }
      return null;
    }
  };
  return { client, state };
};

// Общие фейки reportsStore + photoQueueStore. Обе стороны разделяют один и
// тот же Map photosByReport — в реальной системе это одна и та же таблица
// report_photo (accept() пишет туда же, откуда читает listPhotos), поэтому
// фейки обязаны видеть общее состояние, а не жить в изоляции.
function makeDeps({ reports = new Map(), requiredCodes = new Map() } = {}) {
  const photosByReport = new Map(); // reportId -> Set<photoCode>
  const requiredCodesByReport = new Map(requiredCodes);
  const acceptCalls = [];
  const setRequiredPhotoCodesCalls = [];
  const events = []; // для проверки порядка accept() относительно res.json()

  const reportsStore = {
    async getById(id) {
      return reports.get(Number(id)) || null;
    },
    async listPhotos(reportId) {
      const codes = photosByReport.get(Number(reportId)) || new Set();
      return [...codes].map((photoCode) => ({ reportId: Number(reportId), photoCode }));
    },
    async setReportStatus() {},
    async getRequiredPhotoCodes(reportId) {
      return requiredCodesByReport.has(Number(reportId)) ? requiredCodesByReport.get(Number(reportId)) : null;
    },
    async setRequiredPhotoCodes({ reportId, codes }) {
      setRequiredPhotoCodesCalls.push({ reportId, codes });
      requiredCodesByReport.set(Number(reportId), codes);
    }
  };

  const photoQueueStore = {
    async accept(payload) {
      // Искусственная асинхронная задержка (реальный tick event loop, а не
      // просто await Promise.resolve()): без неё синхронный "префикс" фейка
      // отработал бы и записал событие 'accept' раньше res.json ДАЖЕ если
      // обработчик забыл await перед photoQueueStore.accept(...) — тест
      // перестал бы отличать awaited-вызов от fire-and-forget. Проверено
      // мутацией: без этой задержки снятие await в реальном коде не роняло
      // ни один тест этого файла.
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push({ type: 'accept', payload });
      acceptCalls.push(payload);
      const set = photosByReport.get(Number(payload.reportId)) || new Set();
      set.add(payload.photoCode);
      photosByReport.set(Number(payload.reportId), set);
      return { id: acceptCalls.length };
    }
  };

  return { reportsStore, photoQueueStore, photosByReport, requiredCodesByReport, acceptCalls, setRequiredPhotoCodesCalls, events };
}

function buildRouter({ reportsStore, photoQueueStore, bitrixClient }) {
  return createReportsRouter({
    reportsStore,
    dispatchService: {},
    settingsStore: { async read() { return SETTINGS; } },
    bitrixClient,
    notificationService: {
      async notifyReportDone() {},
      async notifyDispatch() {},
      async notifyReportExpired() {}
    },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() { return { id: 1 }; }, async listByReport() { return []; } },
    photoQueueStore
  });
}

// Образец сборки — существующий tests/reasonRoutes.test.js /
// tests/reportsResync.test.js: находим последний handle зарегистрированного
// роута и вызываем его напрямую, минуя multer/HTTP-транспорт.
function findHandler(router, method, path) {
  const layer = router.stack.find((l) => l?.route?.path === path && l?.route?.methods?.[method]);
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

function makeUploadReq({ reportId, photoCode, buffer, context, adminUserId = 10 }) {
  return {
    params: { id: String(reportId) },
    body: { photoCode },
    file: {
      originalname: 'upload.jpg',
      mimetype: 'image/jpeg',
      buffer: buffer || Buffer.from('mock-image-bytes')
    },
    user: { id: adminUserId },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: context
  };
}

function makeRes(events) {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) {
      this.body = body;
      if (events) events.push({ type: 'json', body });
      return body;
    }
  };
}

// Строит минимальный JPEG с APP1/Exif-сегментом, где DateTimeOriginal стоит
// заведомо старой датой — ручная сборка TIFF/IFD (без сторонних библиотек,
// без моков модуля exifr; тест гоняет РЕАЛЬНЫЙ разбор бинарных байт).
// Конструкция проверена эмпирически: exifr.parse() на таком буфере отдаёт
// { DateTimeOriginal: <Date> } с ожидаемой датой.
function buildJpegWithDateTimeOriginal(dateTimeOriginal) {
  const dateBytes = Buffer.from(`${dateTimeOriginal}\0`, 'ascii');
  const dateLen = dateBytes.length;

  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write('II', 0, 'ascii'); // little-endian
  tiffHeader.writeUInt16LE(42, 2);
  tiffHeader.writeUInt32LE(8, 4); // offset to IFD0

  // IFD0: один entry — указатель на EXIF sub-IFD (tag 0x8769).
  const ifd0Start = 8;
  const ifd0Size = 2 + 12 * 1 + 4;
  const subIfdOffset = ifd0Start + ifd0Size;

  const ifd0 = Buffer.alloc(ifd0Size);
  ifd0.writeUInt16LE(1, 0); // entry count
  ifd0.writeUInt16LE(0x8769, 2); // tag: Exif IFD pointer
  ifd0.writeUInt16LE(4, 4); // type: LONG
  ifd0.writeUInt32LE(1, 6); // count: 1
  ifd0.writeUInt32LE(subIfdOffset, 10); // value: offset to sub-IFD
  ifd0.writeUInt32LE(0, 14); // next IFD offset: none

  // EXIF sub-IFD: один entry — DateTimeOriginal (tag 0x9003).
  const subIfdSize = 2 + 12 * 1 + 4;
  const stringDataOffset = subIfdOffset + subIfdSize;

  const subIfd = Buffer.alloc(subIfdSize);
  subIfd.writeUInt16LE(1, 0); // entry count
  subIfd.writeUInt16LE(0x9003, 2); // tag: DateTimeOriginal
  subIfd.writeUInt16LE(2, 4); // type: ASCII
  subIfd.writeUInt32LE(dateLen, 6); // count: string length incl. null terminator
  subIfd.writeUInt32LE(stringDataOffset, 10); // value: offset to string bytes
  subIfd.writeUInt32LE(0, 14); // next IFD offset: none

  const tiff = Buffer.concat([tiffHeader, ifd0, subIfd, dateBytes]);
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1Length = Buffer.alloc(2);
  app1Length.writeUInt16BE(app1Payload.length + 2, 0);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe1]), // APP1 marker
    app1Length,
    app1Payload,
    Buffer.from([0xff, 0xd9]) // EOI
  ]);
}

// ---------------------------------------------------------------------------
// Тесты из брифа (Шаг 1), тела дописаны реальным кодом сборки роутера.
// ---------------------------------------------------------------------------

test('приём фото не делает НИ ОДНОГО вызова Битрикса при прогретом кэше', async () => {
  const context = { memberId: 'm-t1', domain: 't1.bitrix24.ru' };
  const warm = makeWorkingBitrixClient();
  // Прогреваем МОДУЛЬНЫЙ кэш readRequiredPhotos напрямую, минуя HTTP — так же,
  // как это делает GET /:id при живом Битриксе (см. тест "открытие карточки
  // отчёта..." ниже). report_local_state нарочно остаётся пустым: тест
  // целится именно в уровень 2 (кэш в памяти), а не в уровень 1 (БД).
  await readRequiredPhotos({ bitrixClient: warm.client, settings: SETTINGS, azsId: '601', context });
  assert.ok(warm.state.calls > 0, 'прогрев обязан был реально сходить в Битрикс хотя бы раз');

  const down = makeThrowingBitrixClient();
  const { reportsStore, photoQueueStore, acceptCalls, setRequiredPhotoCodesCalls } = makeDeps({
    reports: new Map([[60101, { id: 60101, azsId: '601', adminUserId: 10 }]])
  });
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: down.client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60101, photoCode: '42', context });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(down.state.calls, 0, 'приём фото не имеет права звать Битрикс, даже когда список известен только из кэша');
  assert.equal(acceptCalls.length, 1);
  // Доп. проверка сверх брифа: уровень 2 (кэш) обязан "заодно заполнить
  // колонку" (см. таблицу в брифе) — следующий приём для этого же отчёта
  // пойдёт уже по уровню 1, даже если кэш протухнет или процесс перезапустят.
  assert.equal(setRequiredPhotoCodesCalls.length, 1,
    'найдя список в кэше (уровень 2), приём обязан backfill-ить report_local_state');
  assert.equal(setRequiredPhotoCodesCalls[0].reportId, 60101);
  assert.deepEqual(setRequiredPhotoCodesCalls[0].codes, ['42', '43']);
});

test('байты попадают в report_photo_blob до ответа телефону', async () => {
  const { reportsStore, photoQueueStore, events } = makeDeps({
    reports: new Map([[60201, { id: 60201, azsId: '602', adminUserId: 10 }]]),
    requiredCodes: new Map([[60201, ['42']]])
  });
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: makeThrowingBitrixClient().client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60201, photoCode: '42', context: { memberId: 'm-t2', domain: 't2.bitrix24.ru' } });
  const res = makeRes(events);
  await handler(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const acceptIndex = events.findIndex((e) => e.type === 'accept');
  const jsonIndex = events.findIndex((e) => e.type === 'json');
  assert.ok(acceptIndex >= 0 && jsonIndex >= 0, 'оба события обязаны произойти');
  assert.ok(acceptIndex < jsonIndex,
    'accept() обязан завершиться ДО res.json — иначе телефон получит 200 раньше, чем байты реально легли в БД');
  assert.ok(Buffer.isBuffer(events[acceptIndex].payload.content), 'accept() обязан получить реальные байты файла');
  assert.ok(events[acceptIndex].payload.content.length > 0);
});

test('ответ приходит со статусом accepted, а не published', async () => {
  const { reportsStore, photoQueueStore } = makeDeps({
    reports: new Map([[60301, { id: 60301, azsId: '603', adminUserId: 10 }]]),
    requiredCodes: new Map([[60301, ['42']]])
  });
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: makeThrowingBitrixClient().client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60301, photoCode: '42', context: { memberId: 'm-t3', domain: 't3.bitrix24.ru' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body?.item?.publishState, 'accepted');
  assert.equal(res.body?.item?.accepted, true);
  // Контракт меняется намеренно: файла в Битриксе на момент ответа ещё нет.
  assert.equal(res.body?.item?.fileId, null);
  assert.equal(res.body?.item?.diskObjectId, null);
  assert.equal(res.body?.item?.folderId, null);
});

test('валидация EXIF по-прежнему синхронная и отвергает старое фото', async () => {
  const { reportsStore, photoQueueStore, acceptCalls } = makeDeps({
    reports: new Map([[60401, { id: 60401, azsId: '604', adminUserId: 10 }]]),
    requiredCodes: new Map([[60401, ['42']]])
  });
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: makeThrowingBitrixClient().client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const oldPhoto = buildJpegWithDateTimeOriginal('2000:01:01 00:00:00');
  const req = makeUploadReq({
    reportId: 60401,
    photoCode: '42',
    context: { memberId: 'm-t4', domain: 't4.bitrix24.ru' },
    buffer: oldPhoto
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(res.body?.errorCode, 'PHOTO_EXIF_TOO_OLD');
  assert.ok(Number.isFinite(res.body?.meta?.ageMinutes), 'meta.ageMinutes обязан быть числом');
  assert.equal(acceptCalls.length, 0, 'старое фото не должно попасть в очередь публикации вовсе');
});

test('недоступность Битрикса больше не мешает принять фото', async () => {
  const { reportsStore, photoQueueStore, acceptCalls } = makeDeps({
    reports: new Map([[60501, { id: 60501, azsId: '605', adminUserId: 10 }]]),
    requiredCodes: new Map([[60501, ['42']]])
  });
  const down = makeThrowingBitrixClient();
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: down.client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60501, photoCode: '42', context: { memberId: 'm-t5', domain: 't5.bitrix24.ru' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(down.state.calls, 0);
  assert.equal(acceptCalls.length, 1);
});

test('после рестарта процесса приём работает при лежащем Битриксе', async () => {
  // azsId '606' с этим portalKey нигде в файле не прогревался — модульный
  // кэш requiredPhotosCache для него заведомо пуст, ровно как после рестарта
  // процесса. required_photo_codes в БД, наоборот, заполнена — это и есть
  // причина, по которой список дублируется в БД, а не только в кэше.
  const { reportsStore, photoQueueStore, acceptCalls } = makeDeps({
    reports: new Map([[60601, { id: 60601, azsId: '606', adminUserId: 10 }]]),
    requiredCodes: new Map([[60601, ['42']]])
  });
  const down = makeThrowingBitrixClient();
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: down.client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60601, photoCode: '42', context: { memberId: 'm-t6', domain: 't6.bitrix24.ru' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(down.state.calls, 0);
  assert.equal(acceptCalls.length, 1);
  assert.equal(acceptCalls[0].slotVerified, true, 'список известен из БД — слот проверен, несмотря на пустой кэш');
});

test('список неизвестен и Битрикс лежит — фото всё равно принимается', async () => {
  const { reportsStore, photoQueueStore, acceptCalls } = makeDeps({
    reports: new Map([[60701, { id: 60701, azsId: '607', adminUserId: 10 }]])
    // requiredCodes НЕ задан для 60701 -> getRequiredPhotoCodes вернёт null,
    // а azsId '607' нигде не прогревался -> кэш тоже пуст (уровень 3).
  });
  const down = makeThrowingBitrixClient();
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: down.client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60701, photoCode: '42', context: { memberId: 'm-t7', domain: 't7.bitrix24.ru' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, 'отказ здесь = несданная смена у человека из-за чужой поломки: ' + JSON.stringify(res.body));
  assert.equal(down.state.calls, 0);
  assert.equal(acceptCalls.length, 1);
  assert.equal(acceptCalls[0].slotVerified, false, 'список неизвестен — слот не проверен, проверку сделает воркер при публикации');

  // Доп. проверка сверх брифа: requiredCodes пуст по конструкции в этой ветке,
  // а Array.prototype.every на пустом массиве возвращает true — без явной
  // защиты allUploaded соврал бы "всё загружено", хотя мы попросту не знаем,
  // что нужно.
  assert.equal(res.body?.item?.requiredCount, 0);
  assert.deepEqual(res.body?.item?.requiredPhotos, []);
  assert.equal(res.body?.item?.allUploaded, false,
    'при неизвестном списке allUploaded не может быть true вакуумно');
});

test('открытие карточки отчёта заполняет required_photo_codes', async () => {
  const context = { memberId: 'm-t8', domain: 't8.bitrix24.ru' };
  const working = makeWorkingBitrixClient();
  const { reportsStore, setRequiredPhotoCodesCalls } = makeDeps({
    reports: new Map([[60801, { id: 60801, azsId: '608', adminUserId: 10 }]])
  });
  const router = buildRouter({ reportsStore, photoQueueStore: null, bitrixClient: working.client });
  const handler = findHandler(router, 'get', '/:id');

  const req = {
    params: { id: '60801' },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: context
  };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(setRequiredPhotoCodesCalls.length, 1, 'GET /:id обязан заполнить required_photo_codes при живом Битриксе');
  assert.equal(setRequiredPhotoCodesCalls[0].reportId, 60801);
  assert.deepEqual(setRequiredPhotoCodesCalls[0].codes, ['42', '43']);
});

// ---------------------------------------------------------------------------
// Дополнительный тест сверх брифа: регресс-гард на то, что уровни 1/2
// по-прежнему ОТВЕРГАЮТ код, которого нет в известном списке. Без него
// slotVerified-логика могла бы случайно превратиться в "всегда принимать
// всё" — брифом такой тест отдельно не продиктован, но именно это различие
// (проверяем, когда список известен / не проверяем, когда неизвестен) и есть
// суть задачи.
// ---------------------------------------------------------------------------

test('[доп.] слот известен локально — код, которого нет в списке, всё равно отвергается', async () => {
  const { reportsStore, photoQueueStore, acceptCalls } = makeDeps({
    reports: new Map([[60901, { id: 60901, azsId: '609', adminUserId: 10 }]]),
    requiredCodes: new Map([[60901, ['42']]])
  });
  const router = buildRouter({ reportsStore, photoQueueStore, bitrixClient: makeThrowingBitrixClient().client });
  const handler = findHandler(router, 'post', '/:id/photo');

  const req = makeUploadReq({ reportId: 60901, photoCode: '999', context: { memberId: 'm-t9', domain: 't9.bitrix24.ru' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(res.body?.errorCode, 'PHOTO_CODE_NOT_REQUIRED');
  assert.equal(acceptCalls.length, 0, 'фото на код вне списка не должно попасть в очередь, когда список ДЕЙСТВИТЕЛЬНО известен');
});
