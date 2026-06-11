import test from 'node:test';
import assert from 'node:assert/strict';
import { readRequiredPhotos } from '../src/reports/reportsRoutes.js';
import {
  AZS_PHOTO_SET_EMPTY,
  AZS_CARD_NOT_FOUND,
  PHOTO_TYPE_NOT_FOUND,
} from '../src/reports/errorCodes.js';

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

// ---------------------------------------------------------------------------
// BUG-007: typed errorCode tests
// ---------------------------------------------------------------------------

test('readRequiredPhotos: empty photoSet returns errorCode AZS_PHOTO_SET_EMPTY and meta.azsId and legacy message', async () => {
  const azsItem = {
    id: 164,
    ufCrm145PhotoSet: []
  };

  await assert.rejects(
    () => readRequiredPhotos({
      bitrixClient: makeBitrixClient(azsItem, []),
      settings: baseSettings,
      azsId: 164
    }),
    (error) => {
      // Typed code for the front-end error dictionary
      assert.equal(error.errorCode, AZS_PHOTO_SET_EMPTY, 'errorCode must be AZS_PHOTO_SET_EMPTY');
      // Legacy internal code — must stay unchanged (backward compat)
      assert.equal(error.code, 'azs_photo_set_empty', 'legacy code must be azs_photo_set_empty');
      // meta carries azsId so the front-end can embed it in the user message
      assert.equal(error.meta?.azsId, '164', 'meta.azsId must be the string form of the passed azsId');
      // message must still be present (front-end fallback)
      assert.ok(typeof error.message === 'string' && error.message.length > 0, 'message must be non-empty');
      return true;
    }
  );
});

test('readRequiredPhotos: AZS item not found returns errorCode AZS_CARD_NOT_FOUND and meta.azsId', async () => {
  // getCrmItem returns null for entityTypeId 145 → AZS not found
  const bitrixClient = {
    getCrmItem: async () => null
  };

  await assert.rejects(
    () => readRequiredPhotos({
      bitrixClient,
      settings: baseSettings,
      azsId: 999
    }),
    (error) => {
      assert.equal(error.errorCode, AZS_CARD_NOT_FOUND, 'errorCode must be AZS_CARD_NOT_FOUND');
      assert.equal(error.code, 'azs_item_not_found', 'legacy code must be azs_item_not_found');
      assert.equal(error.meta?.azsId, '999', 'meta.azsId must be the string form of the passed azsId');
      return true;
    }
  );
});

test('readRequiredPhotos: all photo-type lookups null returns errorCode PHOTO_TYPE_NOT_FOUND and meta.azsId', async () => {
  const azsItem = {
    id: 7,
    ufCrm145PhotoSet: [99, 100]
  };

  await assert.rejects(
    () => readRequiredPhotos({
      // photoType returns null for every id
      bitrixClient: makeBitrixClient(azsItem, []),
      settings: baseSettings,
      azsId: 7
    }),
    (error) => {
      assert.equal(error.errorCode, PHOTO_TYPE_NOT_FOUND, 'errorCode must be PHOTO_TYPE_NOT_FOUND');
      assert.equal(error.code, 'photo_types_not_found', 'legacy code must be photo_types_not_found');
      assert.equal(error.meta?.azsId, '7', 'meta.azsId must be present');
      return true;
    }
  );
});
