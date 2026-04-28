import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFolderPath,
  buildPhotoFileName,
  ensureFolderPath,
  ensureRootFolder,
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
    azsName: 'АЗС 17'
  });

  assert.equal(path, '2026-04/28/АЗС 17');
});

test('buildPhotoFileName creates safe filename from slot/code/timestamp', () => {
  const fileName = buildPhotoFileName({
    slotHHmm: '09:30',
    photoCode: 'Колонка/1',
    capturedAt: new Date('2026-04-28T10:30:45.000Z'),
    extension: '.JPG'
  });

  assert.equal(fileName, '0930_Колонка-1_2026-04-28T10-30-45.000Z.jpg');
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
    azsName: 'АЗС 17',
    slotHHmm: '0930',
    photoCode: 'TOTAL',
    capturedAt: new Date('2026-04-28T10:30:45.000Z'),
    extension: 'png',
    content: Buffer.from('mock-image')
  });

  assert.equal(result.folderPath, '2026-04/28/АЗС 17');
  assert.match(result.fileName, /^0930_TOTAL_2026-04-28T10-30-45.000Z\.png$/);
  assert.equal(diskApi.uploads.length, 1);
  assert.equal(diskApi.uploads[0].fileName, result.fileName);
});

