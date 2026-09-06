import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPublishError, createPhotoPublisher } from '../src/reports/photoPublisher.js';

// ---------------------------------------------------------------------------
// classifyPublishError — дословно из брифа (task-6-brief.md, Шаг 1)
// ---------------------------------------------------------------------------

test('неизвестная ошибка считается временной — потерять фото хуже, чем повторить', () => {
  assert.equal(classifyPublishError(new Error('нечто невиданное')), 'retryable');
});

test('сетевые и 5xx — временные', () => {
  for (const err of [
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('gateway'), { statusCode: 502 }),
    Object.assign(new Error('limit'), { statusCode: 503, bitrixError: 'QUERY_LIMIT_EXCEEDED' })
  ]) {
    assert.equal(classifyPublishError(err), 'retryable', err.message);
  }
});

test('протухший токен — временный: он обновится сам', () => {
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'expired_token' })), 'retryable');
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'wrong_client' })), 'retryable');
});

test('исчерпанная квота Диска — окончательный отказ, нужен человек', () => {
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'DISK_QUOTA_EXCEEDED' })), 'permanent');
});

test('QUERY_LIMIT_EXCEEDED никогда не окончательный — это просьба подождать', () => {
  const err = Object.assign(new Error('x'), { statusCode: 503, bitrixError: 'QUERY_LIMIT_EXCEEDED' });
  assert.equal(classifyPublishError(err), 'retryable');
});

// Добавлено сверх брифа при мутационной проверке: тест выше проверяет только
// DISK_QUOTA_EXCEEDED. Без этого теста мутация «убрать ERROR_NOT_FOUND_FOLDER
// (или ACCESS_DENIED) из PERMANENT_BITRIX_ERRORS» осталась бы незамеченной —
// весь остальной набор тестов остался бы зелёным.
test('ERROR_NOT_FOUND_FOLDER и ACCESS_DENIED — тоже в списке окончательных', () => {
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'ERROR_NOT_FOUND_FOLDER' })), 'permanent');
  assert.equal(classifyPublishError(Object.assign(new Error('x'), { bitrixError: 'ACCESS_DENIED' })), 'permanent');
});

// ---------------------------------------------------------------------------
// Раунд правок 1 (ревью, Critical 1): реалистичные фикстуры — НЕСУЩИЕ.
//
// bitrixRestClient.js (callInternalOnce/callRawOnce) бросает ошибку Bitrix
// ровно в форме `Bitrix REST ${method} error: ${code} ${description}` — код
// живёт ТОЛЬКО в .message. Синтетические фикстуры выше (Object.assign(...,
// {bitrixError: ...})) при первом проходе ревью оказались проверкой
// выдуманного мира: свойство `.bitrixError` нигде в src/ не присваивается,
// поэтому НИ ОДНА настоящая ошибка Битрикса не долетала бы правильно
// классифицированной (эмпирически: реальный DISK_QUOTA_EXCEEDED уходил
// retryable). Синтетические тесты выше оставлены — они и сейчас проходят
// (реализация не отбрасывает `.bitrixError`, а конкатенирует его с `.message`),
// но несущими теперь являются эти.
// ---------------------------------------------------------------------------

const bitrixRestError = (method, code, description = '') =>
  new Error(`Bitrix REST ${method} error: ${code} ${description}`.trim());

test('РЕАЛЬНАЯ форма ошибки (как бросает bitrixRestClient.js): DISK_QUOTA_EXCEEDED — окончательная', () => {
  const error = bitrixRestError('disk.folder.uploadfile', 'DISK_QUOTA_EXCEEDED', 'Disk quota exceeded');
  assert.equal(classifyPublishError(error), 'permanent');
});

test('РЕАЛЬНАЯ форма ошибки: ACCESS_DENIED — окончательная', () => {
  const error = bitrixRestError('disk.folder.getchildren', 'ACCESS_DENIED', 'Access denied');
  assert.equal(classifyPublishError(error), 'permanent');
});

test('РЕАЛЬНАЯ форма ошибки: ERROR_NOT_FOUND_FOLDER — окончательная', () => {
  const error = bitrixRestError('disk.folder.addsubfolder', 'ERROR_NOT_FOUND_FOLDER', 'Could not find entity with id `123`');
  assert.equal(classifyPublishError(error), 'permanent');
});

test('РЕАЛЬНАЯ форма ошибки: QUERY_LIMIT_EXCEEDED — временная', () => {
  const error = bitrixRestError('crm.item.get', 'QUERY_LIMIT_EXCEEDED', 'Too many requests');
  assert.equal(classifyPublishError(error), 'retryable');
});

test('РЕАЛЬНАЯ форма HTTP-отказа без структурированного кода Bitrix — временная по дефолту', () => {
  // Ветка HTTP-failure в bitrixRestClient.js (`Bitrix REST ${method} failed
  // with HTTP ${status}...`) — отдельная от JSON error-ветки, у неё нет кода
  // Bitrix вообще, только статус.
  const error = new Error('Bitrix REST disk.folder.uploadfile failed with HTTP 503: Service Unavailable');
  assert.equal(classifyPublishError(error), 'retryable');
});

test('QUERY_LIMIT_EXCEEDED отбивается первым и безусловно, даже если то же сообщение содержит окончательный код', () => {
  // Сконструированный крайний случай (не наблюдался в проде) — фиксирует
  // КОНТРАКТ порядка проверки, а не воспроизводит реальный текст ошибки. Если
  // бы список окончательных проверялся раньше «никогда не окончательных»,
  // ошибка с обоими сигналами в одном сообщении ушла бы в permanent — и увела
  // бы фото в markFailed вместо оправданного повтора после того, как портал
  // отпустит throttling.
  const error = new Error('QUERY_LIMIT_EXCEEDED ACCESS_DENIED');
  assert.equal(classifyPublishError(error), 'retryable');
});

test('человекочитаемая фраза "access denied" (не код Bitrix) не триггерит permanent — ложное совпадение по смыслу слова, не по точному токену', () => {
  // Ответ на пункт ревью "риск случайного совпадения слова из списка
  // окончательных в тексте временной ошибки": сопоставление идёт по точному
  // токену Bitrix (ACCESS_DENIED, заглавные буквы и подчёркивание), а не по
  // мягкому текстовому смыслу — "access denied" с пробелом (человекочитаемая
  // фраза, например из тела ответа стороннего прокси/WAF при 5xx) не матчит
  // \bACCESS_DENIED\b ни при каком регистре, потому что буквальные символы
  // разные (пробел вместо подчёркивания). Остаточный риск обсуждён в отчёте.
  const error = new Error('upstream proxy returned: access denied, please retry the request later');
  assert.equal(classifyPublishError(error), 'retryable');
});

// ---------------------------------------------------------------------------
// publishOne — общие фейки
// ---------------------------------------------------------------------------

// Фейковый diskApi: каждый метод пишет вызов в общий журнал calls. Папки
// "не существуют" (findChildFolder/findChildFile -> null), поэтому
// ensureFolderPath досоздаёт все сегменты шаблона через createFolder —
// это даёт несколько разных вызовов Битрикса на один publishOne(), а не один,
// иначе assert.equal(limiter.acquired, diskApi.calls) прошёл бы и при
// вырожденном 1-к-1 совпадении, ничего не доказывая о КАЖДОМ вызове.
const makeFakeDiskApi = () => {
  const calls = [];
  return {
    calls,
    async findChildFolder(parentId) {
      calls.push({ method: 'findChildFolder', parentId });
      return null;
    },
    async createFolder(parentId, name) {
      calls.push({ method: 'createFolder', parentId, name });
      return { id: Number(parentId) * 10 + calls.length };
    },
    async findChildFile(parentId, name) {
      calls.push({ method: 'findChildFile', parentId, name });
      return null;
    },
    async markFileDeleted(fileId) {
      calls.push({ method: 'markFileDeleted', fileId });
      return { id: fileId };
    },
    async uploadFile(folderId, { fileName }) {
      calls.push({ method: 'uploadFile', folderId, fileName });
      return { diskObjectId: 5001, crmFileId: 9001, fileName };
    }
  };
};

const makeFakeLimiter = () => {
  let acquired = 0;
  const penalties = [];
  return {
    get acquired() { return acquired; },
    async acquire() { acquired += 1; },
    penalize(ms) { penalties.push(ms); },
    penalties
  };
};

const baseReportsStore = {
  async getById(id) {
    return { id: Number(id), azsId: 'azs-1', slotKey: '2026-05-28:1414' };
  }
};

const baseSettingsStore = {
  async read() {
    return { disk: { rootFolderId: 100, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' } };
  }
};

const baseTask = () => ({
  reportId: 1,
  photoCode: 'photo1',
  content: Buffer.from('fake-bytes'),
  mimeType: 'image/jpeg',
  originalName: 'photo.jpg'
});

test('publishOne берёт токен у ограничителя перед КАЖДЫМ вызовом Битрикса', async () => {
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore: baseSettingsStore,
    reportsStore: baseReportsStore,
    brandStore: null,
    folderIdCache: null,
    limiter
  });

  const result = await publisher.publishOne(baseTask());

  assert.ok(diskApi.calls.length > 1, 'тест бессмыслен, если Битрикс вызывался 0-1 раз — нужно НЕСКОЛЬКО вызовов');
  assert.equal(limiter.acquired, diskApi.calls.length, 'каждый вызов Битрикса обязан быть предварён acquire()');
  assert.equal(diskApi.calls[0].parentId, 100, 'корнем должен быть settings.disk.rootFolderId, раз бренда нет');
  assert.equal(result.fileId, 9001);
  assert.equal(result.diskObjectId, 5001);
  assert.match(result.fileName, /\.jpg$/);
});

// Сверх брифа (таблица мутаций в брифе не называет отдельного теста под это,
// но мастер-инструкция задачи требует именно такое поведение дословно):
// ошибка с retryAfterMs обязана долететь до limiter.penalize(), а не потеряться,
// и сама ошибка обязана пробрасываться вызывающему (чтобы очередь могла
// перепланировать попытку).
test('publishOne сообщает ограничителю retryAfterMs из ошибки Битрикса и пробрасывает саму ошибку', async () => {
  const diskApi = {
    calls: 0,
    async findChildFolder() {
      this.calls += 1;
      const error = new Error('Bitrix REST disk.folder.getchildren failed with HTTP 503');
      error.retryAfterMs = 4000;
      throw error;
    },
    // Не вызываются в этом сценарии (findChildFolder бросает первым), но
    // uploadPhoto/ensureFolderPath проверяют их наличие ДО первого реального
    // похода в Bitrix (guard на форму diskApi) — без стабов тест упал бы на
    // "diskApi must provide uploadFile", а не на проверяемой ошибке 503.
    async createFolder() {
      throw new Error('not reached');
    },
    async uploadFile() {
      throw new Error('not reached');
    }
  };
  const limiter = makeFakeLimiter();

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore: baseSettingsStore,
    reportsStore: baseReportsStore,
    brandStore: null,
    folderIdCache: null,
    limiter
  });

  await assert.rejects(() => publisher.publishOne(baseTask()), /HTTP 503/);
  assert.deepEqual(limiter.penalties, [4000]);
});

// Сверх брифа: часть "той же цепочки", которую просят перенести — учёт папки
// бренда через brandStore.getBrandByAzsId. Без этого теста порт мог бы молча
// потерять брендовый роутинг (например, спутать имя поля disk_folder_id), и
// ничего в мутационной таблице брифа этого бы не поймало.
test('publishOne использует папку бренда как корень, если у бренда настроен disk_folder_id', async () => {
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();
  const brandStore = {
    async getBrandByAzsId(azsId) {
      assert.equal(azsId, 'azs-1');
      return { id: 7, disk_folder_id: 777 };
    }
  };

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore: baseSettingsStore, // rootFolderId: 100 — не должен использоваться
    reportsStore: baseReportsStore,
    brandStore,
    folderIdCache: null,
    limiter
  });

  await publisher.publishOne(baseTask());

  assert.equal(diskApi.calls[0].method, 'findChildFolder');
  assert.equal(diskApi.calls[0].parentId, 777, 'корень должен быть папкой бренда, а не settings.disk.rootFolderId');
});

// ---------------------------------------------------------------------------
// Раунд правок 1 (ревью, Critical 2): settingsStore.read() кэшируется с TTL.
//
// Прод-стор (createCompositeSettingsStore) реально ходит в Bitrix
// (app.option.get) ПЕРВЫМ на каждый read() — локальная БД лишь фоллбек на
// отказ портала. Без кэша это необнаруживаемый REST-вызов на каждую
// публикацию, мимо ограничителя целиком.
// ---------------------------------------------------------------------------

test('publishOne кэширует settingsStore.read() — второй вызов подряд не бьёт по Bitrix повторно', async () => {
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();
  let settingsReadCalls = 0;
  const settingsStore = {
    async read() {
      settingsReadCalls += 1;
      return { disk: { rootFolderId: 100, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' } };
    }
  };

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore,
    reportsStore: baseReportsStore,
    brandStore: null,
    folderIdCache: null,
    limiter
  });

  await publisher.publishOne(baseTask());
  await publisher.publishOne(baseTask());

  assert.equal(settingsReadCalls, 1, 'второй publishOne() обязан переиспользовать закэшированные настройки, а не снова идти в Bitrix');
});

test('publishOne перечитывает настройки после истечения TTL кэша, но НЕ раньше', async () => {
  // Раунд правок 1, самопроверка мутацией (Шаг 5): первая версия этого теста
  // проверяла только "после TTL — 2 вызова", а это условие с тем же успехом
  // проходит и при ПОЛНОСТЬЮ ОТСУТСТВУЮЩЕМ кэше (каждый publishOne() читает
  // настройки заново независимо от часов — тоже 2 вызова на 2 публикации).
  // Мутация "убрать кэш совсем" на такой тест не покраснела. Проверяем ОБА
  // конца: вызов ВНУТРИ TTL не должен перечитывать, вызов ПОСЛЕ TTL — обязан.
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();
  let settingsReadCalls = 0;
  const settingsStore = {
    async read() {
      settingsReadCalls += 1;
      return { disk: { rootFolderId: 100, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' } };
    }
  };
  let clock = 0;

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore,
    reportsStore: baseReportsStore,
    brandStore: null,
    folderIdCache: null,
    limiter,
    settingsCacheTtlMs: 1000,
    now: () => clock
  });

  await publisher.publishOne(baseTask());
  assert.equal(settingsReadCalls, 1, 'первая публикация обязана прочитать настройки');

  clock += 500; // всё ещё ВНУТРИ TTL (1000мс)
  await publisher.publishOne(baseTask());
  assert.equal(settingsReadCalls, 1, 'публикация внутри TTL не должна перечитывать настройки — иначе кэша нет вовсе');

  clock += 600; // суммарно 1100мс — ЗА пределами TTL
  await publisher.publishOne(baseTask());
  assert.equal(settingsReadCalls, 2, 'после истечения TTL публикация обязана перечитать настройки заново');
});

test('publishOne не удваивает settingsStore.read() при двух publishOne(), стартовавших почти одновременно на холодный кэш', async () => {
  // Раунд правок 1, самопроверка мутацией (Шаг 5): первая версия этого теста
  // хранила единственный `resolveRead`, перезаписываемый на каждый вызов
  // settingsStore.read(). При сломанной дедупликации второй вызов read()
  // перезаписывал резолвер первого, тест звал resolveRead() один раз — и
  // ПЕРВЫЙ publishOne() зависал НАВСЕГДА (потерянный резолвер), вместо того
  // чтобы упасть чистым assert. Хуже того: и правильная, и сломанная версия
  // кода в обоих случаях "проходили" тем, что второй уже не вис — просто одна
  // версия делает это через повисший процесс, а не через понятный failure.
  // Теперь резолверы копятся в массиве (ни один не теряется), а число вызовов
  // read() проверяется ДО того, как что-либо резолвится — при сломанной
  // дедупликации это чистый assert.equal(2, 1), а не дедлок теста.
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();
  let settingsReadCalls = 0;
  const pendingResolvers = [];
  const settingsStore = {
    async read() {
      settingsReadCalls += 1;
      // Задержка имитирует реальный REST round-trip — второй publishOne()
      // должен гарантированно застать первый ещё "в полёте" внутри read().
      await new Promise((resolve) => { pendingResolvers.push(resolve); });
      return { disk: { rootFolderId: 100, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' } };
    }
  };

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore,
    reportsStore: baseReportsStore,
    brandStore: null,
    folderIdCache: null,
    limiter
  });

  const first = publisher.publishOne(baseTask());
  // Дать первому вызову дойти строго до settingsStore.read() и повиснуть там
  // (все шаги до него — микрозадачи, setImmediate ждёт их полного дренажа).
  await new Promise((resolve) => setImmediate(resolve));
  const second = publisher.publishOne(baseTask());
  // Ещё один дренаж микрозадач: если дедупликация сломана, second() тоже
  // успеет дойти до своего собственного settingsStore.read() и повиснуть там
  // ДО того, как мы проверим счётчик ниже.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settingsReadCalls, 1, 'два publishOne(), почти одновременно заставших холодный кэш, обязаны дождаться ОДНОГО settingsStore.read()');

  for (const resolve of pendingResolvers) resolve();
  await Promise.all([first, second]);
});

// ---------------------------------------------------------------------------
// Раунд правок 1 (Important): путь snake_case не был покрыт ни одним тестом —
// все тесты publishOne выше кормили camelCase. Форма — ровно та, что отдаёт
// claimBatch() из уже существующего src/reports/photoQueueStore.js.
// ---------------------------------------------------------------------------

test('publishOne принимает snake_case-строку ровно в форме, которую отдаёт claimBatch() из photoQueueStore.js', async () => {
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();

  const publisher = createPhotoPublisher({
    bitrixClient: { diskApi },
    settingsStore: baseSettingsStore,
    reportsStore: baseReportsStore,
    brandStore: null,
    folderIdCache: null,
    limiter
  });

  // Форма — из photoQueueStore.js claimBatch(): rp.id, rp.report_id,
  // rp.photo_code, rp.publish_attempts, rp.exif_at, rp.slot_verified,
  // b.content, b.mime_type, b.original_name.
  const queueRow = {
    id: 42,
    report_id: 1,
    photo_code: 'photo1',
    publish_attempts: 0,
    exif_at: new Date('2026-05-28T09:00:00.000Z'),
    slot_verified: 1,
    content: Buffer.from('fake-bytes-from-queue'),
    mime_type: 'image/jpeg',
    original_name: 'from-queue.jpg'
  };

  const result = await publisher.publishOne(queueRow);

  assert.ok(diskApi.calls.length > 1, 'тест бессмыслен, если Битрикс вызывался 0-1 раз');
  assert.equal(limiter.acquired, diskApi.calls.length, 'snake_case-путь обязан так же попадать под лимитер, как camelCase');
  assert.equal(result.fileId, 9001);
  assert.equal(result.diskObjectId, 5001);
  assert.match(result.fileName, /\.jpg$/);
});

// ---------------------------------------------------------------------------
// BUG-8733: настоящее имя АЗС и настоящее название категории в имени файла.
//
// До правки publishOne читал azsName/requiredTitle ТОЛЬКО из task, а очередь
// публикации их не несёт (claimBatch отдаёт id/report_id/photo_code/exif_at/
// slot_verified/байты) и никто в src/ их туда не клал — значит оба поля были
// всегда пустыми, и в проде срабатывали запасные варианты: id элемента
// смарт-процесса вместо номера станции (104 вместо 486) и «Фото_70» вместо
// названия категории. Наблюдалось на живом файле от 06.09.2026:
// «104_2026-09-06_0750_Фото_70.jpg».
//
// Фикстуры ниже — с боевого портала ОРТК: элемент 104 реестра АЗС
// (entityTypeId=1054) озаглавлен «486», карточка 70 справочника типов фото
// (entityTypeId=1112) — «35. Доска визуального управления», элемент 162 —
// «АЗС 33249» (единственная запись парка с приставкой в заголовке).
// ---------------------------------------------------------------------------

const NAMING_SETTINGS = {
  azs: { entityTypeId: 1054 },
  photoType: { entityTypeId: 1112 },
  disk: { rootFolderId: 100, folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}' }
};

const namingSettingsStore = { async read() { return NAMING_SETTINGS; } };

const namingReportsStore = {
  async getById(id) {
    return { id: Number(id), azsId: '104', slotKey: '2026-09-06:0750' };
  }
};

const namingTask = () => ({
  reportId: 1,
  photoCode: '70',
  content: Buffer.from('fake-bytes'),
  mimeType: 'image/jpeg',
  originalName: 'photo.jpg'
});

// Портал ОБЯЗАН быть опознан (memberId/domain), иначе кэш имён намеренно
// вырождается в отсутствие кэширования — см. buildPortalKey в folderIdCache.js.
const namingContext = () => ({ memberId: 'member-ortk', domain: 'ortk.bitrix24.ru' });

const makeFakeBitrixClient = ({ diskApi, titles = {}, throwOnCrm = null }) => {
  const crmCalls = [];
  return {
    diskApi,
    crmCalls,
    async getCrmItem({ entityTypeId, id }) {
      crmCalls.push({ entityTypeId, id });
      if (throwOnCrm) throw throwOnCrm();
      const title = titles[`${entityTypeId}:${id}`];
      return title === undefined ? null : { id, title };
    }
  };
};

const folderSegments = (diskApi) => diskApi.calls
  .filter((call) => call.method === 'createFolder')
  .map((call) => call.name);

const uploadedFileName = (diskApi) => diskApi.calls.find((call) => call.method === 'uploadFile')?.fileName;

test('BUG-8733: имя файла берёт НОМЕР АЗС из реестра и НАЗВАНИЕ категории из справочника, а не id и «Фото_N»', async () => {
  const diskApi = makeFakeDiskApi();
  const bitrixClient = makeFakeBitrixClient({
    diskApi,
    titles: { '1054:104': '486', '1112:70': '35. Доска визуального управления' }
  });

  const publisher = createPhotoPublisher({
    bitrixClient,
    settingsStore: namingSettingsStore,
    reportsStore: namingReportsStore,
    limiter: makeFakeLimiter(),
    resolveContext: namingContext
  });

  const result = await publisher.publishOne(namingTask());

  assert.equal(
    result.fileName,
    '486_2026-09-06_0750_Доска_визуального_управления.jpg',
    'ровно то имя, которое просил клиент: [Код_АЗС]_[Дата]_[Время]_[Категория]'
  );
  assert.equal(uploadedFileName(diskApi), result.fileName, 'на Диск обязано уехать то же имя, что вернулось наружу');
  assert.deepEqual(
    folderSegments(diskApi),
    ['2026-09', '06', '104_486'],
    'сегмент {azs_name} в пути папки тоже обязан стать номером станции, а не запасным AZS_<id>'
  );
});

test('BUG-8733: недоступный справочник НЕ роняет публикацию — имя откатывается к прежнему запасному варианту', async () => {
  const diskApi = makeFakeDiskApi();
  const bitrixClient = makeFakeBitrixClient({
    diskApi,
    throwOnCrm: () => new Error('Bitrix REST crm.item.get error: QUERY_LIMIT_EXCEEDED Too many requests')
  });
  // logger подменён: отказ обязан ОСТАВИТЬ СЛЕД, а не пройти молча, но и не
  // засорять вывод теста.
  const warnings = [];
  const logger = { warn: (message, meta) => warnings.push({ message, meta }), error() {}, info() {}, debug() {} };

  const publisher = createPhotoPublisher({
    bitrixClient,
    settingsStore: namingSettingsStore,
    reportsStore: namingReportsStore,
    limiter: makeFakeLimiter(),
    resolveContext: namingContext,
    logger
  });

  const result = await publisher.publishOne(namingTask());

  assert.equal(
    result.fileName,
    '104_2026-09-06_0750_Фото_70.jpg',
    'ровно прежнее поведение: id элемента и «Фото_<photoCode>» — сдача отчёта важнее красивого имени'
  );
  assert.deepEqual(folderSegments(diskApi), ['2026-09', '06', '104_AZS_104']);
  assert.equal(warnings.length, 2, 'оба отказа справочника (АЗС и тип фото) обязаны попасть в лог');
  assert.ok(warnings.some((entry) => entry.meta?.event === 'photo_naming_azs_lookup_failed'));
  assert.ok(warnings.some((entry) => entry.meta?.event === 'photo_naming_type_lookup_failed'));
});

test('BUG-8733: приставка «АЗС » в заголовке карточки срезается — в имени остаётся только код станции', async () => {
  const diskApi = makeFakeDiskApi();
  const bitrixClient = makeFakeBitrixClient({
    diskApi,
    titles: { '1054:162': 'АЗС 33249', '1112:70': '35. Доска визуального управления' }
  });

  const publisher = createPhotoPublisher({
    bitrixClient,
    settingsStore: namingSettingsStore,
    reportsStore: { async getById(id) { return { id: Number(id), azsId: '162', slotKey: '2026-09-06:0750' }; } },
    limiter: makeFakeLimiter(),
    resolveContext: namingContext
  });

  const result = await publisher.publishOne(namingTask());

  assert.ok(result.fileName.startsWith('33249_'), `ожидали «33249_...», получили «${result.fileName}»`);
  assert.deepEqual(folderSegments(diskApi), ['2026-09', '06', '162_33249']);
});

test('BUG-8733: тип фото, которого нет в справочнике, оставляет прежнюю категорию «Фото_N» и не мешает остальному имени', async () => {
  const diskApi = makeFakeDiskApi();
  // Карточка АЗС есть, карточки типа 70 — нет (getCrmItem вернёт null).
  const bitrixClient = makeFakeBitrixClient({ diskApi, titles: { '1054:104': '486' } });

  const publisher = createPhotoPublisher({
    bitrixClient,
    settingsStore: namingSettingsStore,
    reportsStore: namingReportsStore,
    limiter: makeFakeLimiter(),
    resolveContext: namingContext
  });

  const result = await publisher.publishOne(namingTask());

  assert.equal(
    result.fileName,
    '486_2026-09-06_0750_Фото_70.jpg',
    'номер станции уже настоящий, категория — запасная: частичный отказ справочника не обесценивает то, что удалось узнать'
  );
});

test('BUG-8733: имена справочников кэшируются — вторая публикация не ходит в Битрикс повторно', async () => {
  const diskApi = makeFakeDiskApi();
  const bitrixClient = makeFakeBitrixClient({
    diskApi,
    titles: { '1054:104': '486', '1112:70': '35. Доска визуального управления' }
  });

  const publisher = createPhotoPublisher({
    bitrixClient,
    settingsStore: namingSettingsStore,
    reportsStore: namingReportsStore,
    limiter: makeFakeLimiter(),
    resolveContext: namingContext
  });

  const first = await publisher.publishOne(namingTask());
  const second = await publisher.publishOne(namingTask());

  assert.equal(first.fileName, second.fileName);
  assert.deepEqual(
    bitrixClient.crmCalls,
    [{ entityTypeId: 1054, id: 104 }, { entityTypeId: 1112, id: 70 }],
    'ровно два crm.item.get на две публикации: без кэша их было бы четыре, а на смене из 40 фото — восемьдесят'
  );
});

test('BUG-8733: обращения к справочнику тоже оплачиваются токеном ограничителя темпа', async () => {
  const diskApi = makeFakeDiskApi();
  const limiter = makeFakeLimiter();
  const bitrixClient = makeFakeBitrixClient({
    diskApi,
    titles: { '1054:104': '486', '1112:70': '35. Доска визуального управления' }
  });

  const publisher = createPhotoPublisher({
    bitrixClient,
    settingsStore: namingSettingsStore,
    reportsStore: namingReportsStore,
    limiter,
    resolveContext: namingContext
  });

  await publisher.publishOne(namingTask());

  assert.equal(
    limiter.acquired,
    diskApi.calls.length + bitrixClient.crmCalls.length,
    'КАЖДОЕ обращение к порталу — и Диск, и crm.item.get — обязано быть предварено acquire()'
  );
});
