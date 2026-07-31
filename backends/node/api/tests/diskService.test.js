import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFolderPath,
  buildPhotoFileName,
  ensureFolderPath,
  ensureRootFolder,
  isSupportedPhotoUpload,
  resolvePhotoFileExtension,
  uploadPhoto
} from '../src/disk/diskService.js';
import { createFolderIdCache } from '../src/disk/folderIdCache.js';

// Точный формат ошибки Bitrix REST на несуществующий id папки/файла — как его
// реально оборачивает bitrixRestClient.js (`Bitrix REST ${method} error: ...`)
// поверх кода и текста, которые официально документированы для
// disk.folder.getchildren / disk.folder.addsubfolder / disk.folder.uploadfile
// (b24restdocs, все три метода): единственный код именно про «id не найден».
const notFoundError = (method, id) => new Error(
  `Bitrix REST ${method} error: ERROR_NOT_FOUND Could not find entity with id \`${id}\``
);

const createDiskApiFake = ({ uploadBehaviors = [] } = {}) => {
  let seq = 100;
  const folders = new Map();
  const uploads = [];
  const files = new Map();
  const deletedFileIds = [];
  // Папки, которые «удалили в Bitrix» — обращение к ним по id (как к parentId
  // в getchildren/addsubfolder или как к folderId в uploadfile) должно падать
  // с ERROR_NOT_FOUND, а не молча возвращать пустой список/успех. Использует
  // deleteFolder(id) ниже — специально для тестов на протухший кэш.
  const deletedFolderIds = new Set();
  const callCounts = {
    findChildFolder: 0,
    createFolder: 0,
    findChildFile: 0,
    markFileDeleted: 0,
    uploadFile: 0
  };
  let uploadAttempt = 0;

  const keyOf = (parentId, name) => `${parentId}:${name}`;

  const assertFolderExists = (method, folderId) => {
    if (deletedFolderIds.has(Number(folderId))) {
      throw notFoundError(method, folderId);
    }
  };

  return {
    uploads,
    folders,
    files,
    deletedFileIds,
    callCounts,
    // Симулирует удаление папки в Bitrix: она (а) пропадает из выдачи
    // getchildren её родителя — поэтому свежий (некэшированный) обход её
    // молча пересоздаст, как это уже умеет ensureFolderPath; и (б) прямое
    // обращение к ней по id (как к parentId/folderId в getchildren /
    // addsubfolder / uploadfile) начинает падать с ERROR_NOT_FOUND — именно
    // так проявляется протухший закэшированный id, минуя обход через родителя.
    deleteFolder(folderId) {
      const numericId = Number(folderId);
      deletedFolderIds.add(numericId);
      for (const [key, currentId] of folders.entries()) {
        if (Number(currentId) === numericId) {
          folders.delete(key);
        }
      }
    },
    setExistingFile(parentId, name, id = null) {
      const fileId = Number(id) > 0 ? Number(id) : (seq += 1);
      files.set(keyOf(parentId, name), fileId);
      return fileId;
    },
    async findChildFolder(parentId, name) {
      callCounts.findChildFolder += 1;
      assertFolderExists('disk.folder.getchildren', parentId);
      const id = folders.get(keyOf(parentId, name));
      return id ? { id } : null;
    },
    async findChildFile(parentId, name) {
      callCounts.findChildFile += 1;
      assertFolderExists('disk.folder.getchildren', parentId);
      const id = files.get(keyOf(parentId, name));
      return id ? { id } : null;
    },
    async createFolder(parentId, name) {
      callCounts.createFolder += 1;
      assertFolderExists('disk.folder.addsubfolder', parentId);
      const key = keyOf(parentId, name);
      if (folders.has(key)) {
        return { id: folders.get(key) };
      }
      seq += 1;
      folders.set(key, seq);
      return { id: seq };
    },
    async markFileDeleted(fileId) {
      callCounts.markFileDeleted += 1;
      const numericId = Number(fileId);
      deletedFileIds.push(numericId);
      for (const [key, currentId] of files.entries()) {
        if (Number(currentId) === numericId) {
          files.delete(key);
        }
      }
      return { id: numericId };
    },
    async uploadFile(folderId, { fileName, content }) {
      callCounts.uploadFile += 1;
      uploadAttempt += 1;
      assertFolderExists('disk.folder.uploadfile', folderId);
      uploads.push({ folderId, fileName, content });
      const behavior = uploadBehaviors[uploadAttempt - 1];
      const key = keyOf(folderId, fileName);

      if (behavior === 'duplicate_error') {
        const conflictId = seq + 5000;
        files.set(key, conflictId);
        throw new Error('Bitrix REST disk.folder.uploadfile failed with HTTP 400: {"error":"DISK_OBJ_22000","error_description":"Файл с таким именем уже есть"}');
      }

      if (files.has(key)) {
        throw new Error('Bitrix REST disk.folder.uploadfile failed with HTTP 400: {"error":"DISK_OBJ_22000","error_description":"Файл с таким именем уже есть"}');
      }

      seq += 1;
      files.set(key, seq);
      return { diskObjectId: seq, crmFileId: seq + 100000, fileName };
    }
  };
};

test('buildFolderPath uses default YYYY-MM/DD/AZS pattern', () => {
  const path = buildFolderPath({
    capturedAt: new Date('2026-04-28T10:30:45.000Z'),
    azsId: '17',
    azsName: 'АЗС 17'
  });

  assert.equal(path, '2026-04/28/17_АЗС 17');
});

test('buildFolderPath supports {azs_name} token with fallback when azsName is empty', () => {
  const path = buildFolderPath({
    capturedAt: new Date('2026-04-28T10:30:45.000Z'),
    azsId: '17',
    azsName: '',
    folderNameTemplate: '{yyyy-mm}/{dd}/{azs}_{azs_name}'
  });

  assert.equal(path, '2026-04/28/17_AZS_17');
});

test('buildPhotoFileName uses the AZS name (not id) as the first segment', () => {
  const fileName = buildPhotoFileName({
    azsId: 4,
    azsName: 'АЗС 17',
    slotDate: '2026-05-28',
    slotHHmm: '1414',
    photoCode: '42',
    requiredTitle: '42. Колонки',
    originalName: 'photo.JPEG',
    mimeType: 'image/jpeg'
  });

  assert.equal(fileName, 'АЗС_17_2026-05-28_1414_Колонки.jpg');
});

test('buildPhotoFileName falls back to azsId when azsName is empty', () => {
  const fileName = buildPhotoFileName({
    azsId: 4,
    slotDate: '2026-05-28',
    slotHHmm: '1414',
    photoCode: '42',
    requiredTitle: '42. Колонки',
    originalName: 'photo.JPEG',
    mimeType: 'image/jpeg'
  });

  assert.equal(fileName, '4_2026-05-28_1414_Колонки.jpg');
});

test('buildPhotoFileName strips repeated numeric prefixes and keeps extension from original name', () => {
  const fileName = buildPhotoFileName({
    azsId: 4,
    slotDate: '2026-05-28',
    slotHHmm: '1414',
    photoCode: '44',
    requiredTitle: '3. 3. Общий вид',
    originalName: 'snapshot.png',
    mimeType: 'image/png'
  });

  assert.equal(fileName, '4_2026-05-28_1414_Общий_вид.png');
});

test('buildPhotoFileName keeps heic extension when supported', () => {
  const fileName = buildPhotoFileName({
    azsId: 4,
    slotDate: '2026-05-28',
    slotHHmm: '1414',
    photoCode: '50',
    requiredTitle: '50. Общий вид',
    originalName: 'IMG_0001.HEIC',
    mimeType: 'image/heic'
  });

  assert.equal(fileName, '4_2026-05-28_1414_Общий_вид.heic');
});

test('resolvePhotoFileExtension derives supported extension from MIME when name is missing or unsupported', () => {
  assert.equal(resolvePhotoFileExtension({
    originalName: 'upload',
    mimeType: 'image/png'
  }), 'png');
  assert.equal(resolvePhotoFileExtension({
    originalName: 'upload.tmp',
    mimeType: 'image/jpeg'
  }), 'jpg');
});

test('isSupportedPhotoUpload rejects files without a supported image extension or MIME type', () => {
  assert.equal(isSupportedPhotoUpload({
    originalName: 'document.pdf',
    mimeType: 'application/pdf'
  }), false);
  assert.equal(isSupportedPhotoUpload({
    originalName: 'archive.zip',
    mimeType: ''
  }), false);
  assert.equal(isSupportedPhotoUpload({
    originalName: 'camera',
    mimeType: ''
  }), true);
});

test('buildFolderPath requires azsId when template contains AZS segment', () => {
  assert.throws(
    () => buildFolderPath({
      capturedAt: new Date('2026-05-28T10:30:45.000Z'),
      azsName: 'АЗС 4'
    }),
    /azsId is required/
  );
});

test('ensureFolderPath reuses existing folders and creates missing only once', async () => {
  const diskApi = createDiskApiFake();

  const first = await ensureFolderPath(diskApi, {
    rootFolderId: 10,
    path: '2026-04/28/АЗС 17'
  });
  const foldersCountAfterFirst = diskApi.folders.size;

  const second = await ensureFolderPath(diskApi, {
    rootFolderId: 10,
    path: '2026-04/28/АЗС 17'
  });

  assert.equal(second, first);
  assert.equal(diskApi.folders.size, foldersCountAfterFirst);
});

test('ensureRootFolder prefers configured root folder id', async () => {
  const diskApi = createDiskApiFake();
  const rootFolderId = await ensureRootFolder(diskApi, {
    configuredRootFolderId: 555,
    storageRootId: 10
  });

  assert.equal(rootFolderId, 555);
  assert.equal(diskApi.folders.size, 0);
});

test('uploadPhoto creates folder path and uploads file with required pattern', async () => {
  const diskApi = createDiskApiFake();

  const result = await uploadPhoto(diskApi, {
    rootFolderId: 10,
    azsId: 4,
    azsName: 'АЗС 4',
    slotDate: '2026-05-28',
    slotHHmm: '0930',
    photoCode: '42',
    requiredTitle: '42. Колонки',
    originalName: 'upload.jpg',
    mimeType: 'image/jpeg',
    capturedAt: new Date('2026-04-28T10:30:45.000Z'),
    content: Buffer.from('mock-image')
  });

  assert.equal(result.folderPath, '2026-05/28/4_АЗС 4');
  assert.equal(result.fileName, 'АЗС_4_2026-05-28_0930_Колонки.jpg');
  assert.equal(diskApi.uploads.length, 1);
  assert.equal(diskApi.deletedFileIds.length, 0);
  assert.equal(diskApi.uploads[0].fileName, result.fileName);
  assert.ok(Number(result.fileId) > 0);
  assert.ok(Number(result.diskObjectId) > 0);
});

test('uploadPhoto marks existing duplicate file as deleted before upload', async () => {
  const diskApi = createDiskApiFake();
  const expectedFolderPath = '2026-05/28/4_AZS_4';
  const expectedFileName = '4_2026-05-28_0930_Колонки.jpg';
  const folderId = await ensureFolderPath(diskApi, {
    rootFolderId: 10,
    path: expectedFolderPath
  });
  const existingFileId = diskApi.setExistingFile(folderId, expectedFileName, 777);

  const result = await uploadPhoto(diskApi, {
    rootFolderId: 10,
    azsId: 4,
    slotDate: '2026-05-28',
    slotHHmm: '0930',
    photoCode: '42',
    requiredTitle: '42. Колонки',
    originalName: 'upload.jpg',
    mimeType: 'image/jpeg',
    content: Buffer.from('mock-image')
  });

  assert.equal(result.folderId, folderId);
  assert.equal(result.fileName, expectedFileName);
  assert.deepEqual(diskApi.deletedFileIds, [existingFileId]);
  assert.equal(diskApi.uploads.length, 1);
});

test('uploadPhoto retries once after DISK_OBJ_22000 race and succeeds', async () => {
  const diskApi = createDiskApiFake({ uploadBehaviors: ['duplicate_error'] });

  const result = await uploadPhoto(diskApi, {
    rootFolderId: 10,
    azsId: 4,
    slotDate: '2026-05-28',
    slotHHmm: '0930',
    photoCode: '42',
    requiredTitle: '42. Колонки',
    originalName: 'upload.jpg',
    mimeType: 'image/jpeg',
    content: Buffer.from('mock-image')
  });

  assert.equal(result.fileName, '4_2026-05-28_0930_Колонки.jpg');
  assert.equal(diskApi.uploads.length, 2);
  assert.equal(diskApi.deletedFileIds.length, 1);
});

// C2b: uploadPhoto must not hang forever when Bitrix Disk stalls. uploadFile
// below never resolves/rejects on its own (simulates a stuck disk.folder.uploadfile
// call) — uploadPhoto is expected to reject with a bounded, retryable error
// once the configured uploadTimeoutMs elapses, instead of hanging indefinitely.
test('uploadPhoto rejects with a retryable timeout error when Disk upload hangs', async () => {
  const diskApi = {
    async findChildFolder() { return null; },
    async createFolder(parentId, name) { return { id: 999 }; },
    async findChildFile() { return null; },
    async markFileDeleted() { return { id: 0 }; },
    uploadFile() {
      // Never resolves — simulates a hung disk.folder.uploadfile call.
      return new Promise(() => {});
    }
  };

  const start = Date.now();
  await assert.rejects(
    () => uploadPhoto(diskApi, {
      rootFolderId: 10,
      azsId: 4,
      slotDate: '2026-05-28',
      slotHHmm: '0930',
      photoCode: '42',
      requiredTitle: '42. Колонки',
      originalName: 'upload.jpg',
      mimeType: 'image/jpeg',
      content: Buffer.from('mock-image'),
      uploadTimeoutMs: 50
    }),
    (error) => {
      assert.match(error.message, /gateway timeout/i);
      assert.equal(error.statusCode, 504);
      return true;
    }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `uploadPhoto should reject promptly on timeout, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Folder id cache (perf(DISK): 6-7 запросов Битрикса на фото -> путь
// резолвится раз в сутки на АЗС). Каждый тест ниже читает call-счётчики
// фейкового diskApi — это прямая проверка числа REST-обращений, а не только
// конечного результата.
// ---------------------------------------------------------------------------

const commonPhotoArgs = (overrides = {}) => ({
  rootFolderId: 10,
  azsId: 4,
  azsName: 'АЗС 4',
  slotDate: '2026-05-28',
  slotHHmm: '0930',
  photoCode: '42',
  requiredTitle: '42. Колонки',
  originalName: 'upload.jpg',
  mimeType: 'image/jpeg',
  content: Buffer.from('mock-image'),
  ...overrides
});

test('ensureFolderPath: without folderIdCache the walk repeats on every call (legacy behaviour, unchanged)', async () => {
  const diskApi = createDiskApiFake();

  await ensureFolderPath(diskApi, { rootFolderId: 10, path: '2026-07/31/12_Station' });
  const callsAfterFirst = diskApi.callCounts.findChildFolder;
  assert.ok(callsAfterFirst > 0);

  await ensureFolderPath(diskApi, { rootFolderId: 10, path: '2026-07/31/12_Station' });
  assert.ok(
    diskApi.callCounts.findChildFolder > callsAfterFirst,
    'every call without a cache must re-walk the path — this is the pre-existing, unchanged behaviour for callers that do not opt in'
  );
});

test('ensureFolderPath: a cache hit for the same (portal, root, path) makes zero findChildFolder/createFolder calls', async () => {
  const diskApi = createDiskApiFake();
  const folderIdCache = createFolderIdCache();
  const context = { memberId: 'member-1', domain: 'a.bitrix24.ru' };

  const first = await ensureFolderPath(diskApi, {
    rootFolderId: 10,
    path: '2026-07/31/12_Station',
    folderIdCache
  }, context);
  const callsAfterFirst = { ...diskApi.callCounts };
  assert.ok(callsAfterFirst.findChildFolder > 0, 'first resolution must actually walk the path');

  const second = await ensureFolderPath(diskApi, {
    rootFolderId: 10,
    path: '2026-07/31/12_Station',
    folderIdCache
  }, context);

  assert.equal(second, first);
  assert.equal(diskApi.callCounts.findChildFolder, callsAfterFirst.findChildFolder, 'no new findChildFolder calls on a cache hit');
  assert.equal(diskApi.callCounts.createFolder, callsAfterFirst.createFolder, 'no new createFolder calls on a cache hit');
});

test('uploadPhoto: a second upload to the same folder path performs zero folder-resolution calls', async () => {
  const diskApi = createDiskApiFake();
  const folderIdCache = createFolderIdCache();
  const context = { memberId: 'member-1', domain: 'a.bitrix24.ru' };

  await uploadPhoto(diskApi, commonPhotoArgs({ folderIdCache, originalName: 'first.jpg' }), context);
  const findChildFolderCallsAfterFirst = diskApi.callCounts.findChildFolder;
  const createFolderCallsAfterFirst = diskApi.callCounts.createFolder;
  assert.ok(findChildFolderCallsAfterFirst > 0, 'the first upload of the day must actually resolve the folder path');

  // Second photo for the same AZS/day -> identical folder path, different file.
  await uploadPhoto(diskApi, commonPhotoArgs({
    folderIdCache,
    photoCode: '43',
    requiredTitle: '43. Топливо',
    originalName: 'second.jpg'
  }), context);

  assert.equal(diskApi.callCounts.findChildFolder, findChildFolderCallsAfterFirst, 'no new findChildFolder calls on the second upload to the same path — this is the whole point');
  assert.equal(diskApi.callCounts.createFolder, createFolderCallsAfterFirst, 'no new createFolder calls on the second upload to the same path');
  assert.equal(diskApi.callCounts.uploadFile, 2, 'the upload call itself still happens for every photo');
});

test('uploadPhoto: a different portal with the identical folder path never touches the other portal\'s diskApi (no cross-portal reuse)', async () => {
  const diskApiA = createDiskApiFake();
  const diskApiB = createDiskApiFake();
  // ONE cache instance shared across portals, exactly as in production
  // (createReportsRouter builds a single process-wide folderIdCache).
  const folderIdCache = createFolderIdCache();
  const contextA = { memberId: 'member-A', domain: 'a.bitrix24.ru' };
  const contextB = { memberId: 'member-B', domain: 'b.bitrix24.ru' };
  // Deliberately identical rootFolderId/azsId/date/template on both portals —
  // the collision scenario the task calls the highest-severity risk.
  const args = commonPhotoArgs({ folderIdCache });

  await uploadPhoto(diskApiA, args, contextA);
  assert.equal(diskApiB.callCounts.findChildFolder, 0, 'portal A\'s upload must never call portal B\'s diskApi');
  assert.equal(diskApiB.uploads.length, 0, 'portal A\'s upload must never land a file via portal B\'s diskApi');

  await uploadPhoto(diskApiB, args, contextB);
  assert.ok(
    diskApiB.callCounts.findChildFolder > 0,
    'portal B must perform its OWN folder resolution against its OWN diskApi — reusing a cached id resolved against diskApiA would skip this entirely'
  );
  assert.equal(diskApiA.uploads.length, 1);
  assert.equal(diskApiB.uploads.length, 1);
});

test('uploadPhoto: a stale cached folder id is evicted and the path is re-resolved once, then the upload succeeds', async () => {
  const diskApi = createDiskApiFake();
  const folderIdCache = createFolderIdCache();
  const context = { memberId: 'member-1', domain: 'a.bitrix24.ru' };
  const args = commonPhotoArgs({ folderIdCache });

  const first = await uploadPhoto(diskApi, { ...args, originalName: 'first.jpg' }, context);
  assert.equal(diskApi.uploads.length, 1);

  // Somebody deletes the cached folder directly in Bitrix.
  diskApi.deleteFolder(first.folderId);

  const second = await uploadPhoto(diskApi, { ...args, originalName: 'second.jpg' }, context);

  assert.equal(diskApi.uploads.length, 2, 'the retried upload must actually succeed and land the second file');
  assert.notEqual(second.folderId, first.folderId, 'recovery must re-create the folder under a NEW id, not keep using the deleted one');

  // The cache must now hold the corrected id — a third upload is a clean
  // cache hit again, proving recovery did not leave the cache disabled/broken.
  const findChildFolderCallsAfterSecond = diskApi.callCounts.findChildFolder;
  const third = await uploadPhoto(diskApi, { ...args, originalName: 'third.jpg' }, context);
  assert.equal(third.folderId, second.folderId);
  assert.equal(diskApi.callCounts.findChildFolder, findChildFolderCallsAfterSecond, 'third upload is a cache hit against the corrected id, not another re-walk');
});

test('uploadPhoto: without folderIdCache, an ERROR_NOT_FOUND failure propagates once with no special-cased retry (unchanged legacy behaviour)', async () => {
  // Guards the scope of the new retry path: it must only trigger when the
  // folder id actually came from the cache. Without a cache, uploadPhoto
  // always resolves the path fresh (self-healing against a deleted leaf/
  // intermediate segment, exactly as before this change) — the only way to
  // still hit ERROR_NOT_FOUND is when even the starting rootFolderId itself
  // is gone, which is a pre-existing, unrelated failure mode this change must
  // not paper over with a retry.
  const diskApi = createDiskApiFake();
  const context = { memberId: 'member-1', domain: 'a.bitrix24.ru' };
  const args = commonPhotoArgs(); // no folderIdCache at all

  diskApi.deleteFolder(args.rootFolderId);

  await assert.rejects(
    () => uploadPhoto(diskApi, args, context),
    (error) => /ERROR_NOT_FOUND/.test(error.message)
  );
  assert.equal(diskApi.callCounts.findChildFolder, 1, 'exactly one attempt — no folderIdCache means the new retry path never engages');
  assert.equal(diskApi.uploads.length, 0);
});

test('uploadPhoto: if recovery also fails (root folder itself is gone) the error propagates without an infinite retry loop', async () => {
  const diskApi = createDiskApiFake();
  const folderIdCache = createFolderIdCache();
  const context = { memberId: 'member-1', domain: 'a.bitrix24.ru' };
  const args = commonPhotoArgs({ folderIdCache });

  const first = await uploadPhoto(diskApi, { ...args, originalName: 'first.jpg' }, context);
  assert.equal(diskApi.uploads.length, 1);

  diskApi.deleteFolder(first.folderId);
  diskApi.deleteFolder(args.rootFolderId); // even the uncached retry cannot self-heal from here

  await assert.rejects(
    () => uploadPhoto(diskApi, { ...args, originalName: 'second.jpg' }, context),
    (error) => /ERROR_NOT_FOUND/.test(error.message)
  );
  assert.equal(diskApi.uploads.length, 1, 'no second file must be uploaded when recovery itself fails — exactly one retry, then give up');
});

test('uploadPhoto: repeated uploads across many stations/days do not grow the shared cache without bound', async () => {
  const diskApi = createDiskApiFake();
  const folderIdCache = createFolderIdCache({ maxEntries: 3 });
  const context = { memberId: 'member-1', domain: 'a.bitrix24.ru' };

  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await uploadPhoto(diskApi, commonPhotoArgs({
      folderIdCache,
      azsId: String(i),
      azsName: `АЗС ${i}`,
      originalName: `station-${i}.jpg`
    }), context);
    assert.ok(folderIdCache.size <= 3, `cache size ${folderIdCache.size} exceeded the configured cap after station ${i}`);
  }

  assert.equal(folderIdCache.size, 3);
});
