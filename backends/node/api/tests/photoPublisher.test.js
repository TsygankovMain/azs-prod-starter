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
