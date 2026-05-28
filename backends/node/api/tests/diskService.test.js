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

const createDiskApiFake = () => {
  let seq = 100;
  const folders = new Map();
  const uploads = [];

  const keyOf = (parentId, name) => `${parentId}:${name}`;

  return {
    uploads,
    folders,
    async findChildFolder(parentId, name) {
      const id = folders.get(keyOf(parentId, name));
      return id ? { id } : null;
    },
    async createFolder(parentId, name) {
      const key = keyOf(parentId, name);
      if (folders.has(key)) {
        return { id: folders.get(key) };
      }
      seq += 1;
      folders.set(key, seq);
      return { id: seq };
    },
    async uploadFile(folderId, { fileName, content }) {
      uploads.push({ folderId, fileName, content });
      seq += 1;
      return { id: seq, fileName };
    }
  };
};

test('buildFolderPath uses default YYYY-MM/DD/AZS pattern', () => {
  const path = buildFolderPath({
    capturedAt: new Date('2026-04-28T10:30:45.000Z'),
    azsId: '17',
    azsName: 'АЗС 17'
  });

  assert.equal(path, '2026-04/28/17');
});

test('buildPhotoFileName creates AZS/date/time/category filename', () => {
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

  assert.equal(result.folderPath, '2026-05/28/4');
  assert.equal(result.fileName, '4_2026-05-28_0930_Колонки.jpg');
  assert.equal(diskApi.uploads.length, 1);
  assert.equal(diskApi.uploads[0].fileName, result.fileName);
});
