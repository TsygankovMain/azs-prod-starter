import test from 'node:test';
import assert from 'node:assert/strict';
import { readRequiredPhotos } from '../src/reports/reportsRoutes.js';

const baseSettings = {
  azs: {
    entityTypeId: 145,
    fields: { photoSet: 'ufCrm145PhotoSet' }
  },
  photoType: {
    entityTypeId: 1112
  }
};

const makeBitrixClient = (azsItem, photoTypeItems) => ({
  getCrmItem: async ({ entityTypeId, id }) => {
    if (entityTypeId === 145) {
      return azsItem;
    }
    if (entityTypeId === 1112) {
      return photoTypeItems.find((item) => Number(item.id ?? item.ID) === Number(id)) || null;
    }
    return null;
  }
});

test('readRequiredPhotos returns items sorted ASC by id with id as code and standard title', async () => {
  const azsItem = {
    id: 7,
    title: 'АЗС №14',
    ufCrm145PhotoSet: [42, 50, 44]
  };
  const photoTypeItems = [
    { id: 50, title: '50. Касса' },
    { id: 42, title: '42. Колонки' },
    { id: 44, title: '44. Витрина' }
  ];

  const result = await readRequiredPhotos({
    bitrixClient: makeBitrixClient(azsItem, photoTypeItems),
    settings: baseSettings,
    azsId: 7
  });

  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.code), ['42', '44', '50']);
  assert.equal(result[0].title, '42. Колонки');
  assert.equal(result[1].title, '44. Витрина');
  assert.equal(result[2].title, '50. Касса');
  assert.equal(result[0].sort, 42);
  assert.equal(result[2].sort, 50);
});

test('readRequiredPhotos falls back to "Фото #<id>" when standard title is empty', async () => {
  const azsItem = {
    id: 7,
    ufCrm145PhotoSet: [42]
  };
  const photoTypeItems = [
    { id: 42, title: '' }
  ];

  const result = await readRequiredPhotos({
    bitrixClient: makeBitrixClient(azsItem, photoTypeItems),
    settings: baseSettings,
    azsId: 7
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].code, '42');
  assert.equal(result[0].title, 'Фото #42');
});

test('readRequiredPhotos throws azs_photo_set_empty when photoSet is empty', async () => {
  const azsItem = {
    id: 7,
    ufCrm145PhotoSet: []
  };

  await assert.rejects(
    () => readRequiredPhotos({
      bitrixClient: makeBitrixClient(azsItem, []),
      settings: baseSettings,
      azsId: 7
    }),
    (error) => {
      assert.equal(error.code, 'azs_photo_set_empty');
      return true;
    }
  );
});

test('readRequiredPhotos throws photo_types_not_found when all photo type lookups return null', async () => {
  const azsItem = {
    id: 7,
    ufCrm145PhotoSet: [99, 100]
  };

  await assert.rejects(
    () => readRequiredPhotos({
      bitrixClient: makeBitrixClient(azsItem, []),
      settings: baseSettings,
      azsId: 7
    }),
    (error) => {
      assert.equal(error.code, 'photo_types_not_found');
      return true;
    }
  );
});

test('readRequiredPhotos supports UPPER_CASE ID/TITLE fallback from Bitrix payload', async () => {
  const azsItem = {
    ID: 7,
    ufCrm145PhotoSet: [42]
  };
  const photoTypeItems = [
    { ID: 42, TITLE: 'Старый формат' }
  ];

  const result = await readRequiredPhotos({
    bitrixClient: makeBitrixClient(azsItem, photoTypeItems),
    settings: baseSettings,
    azsId: 7
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].code, '42');
  assert.equal(result[0].title, 'Старый формат');
});
