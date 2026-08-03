import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequiredPhotosCache } from '../src/reports/requiredPhotosCache.js';

test('пустой portalKey не кэшируется — ни на запись, ни на чтение', () => {
  const cache = createRequiredPhotosCache();
  cache.setAzsSet('', 12, { photoTypeIds: [1, 2], azsTitle: 'АЗС 12' });
  assert.equal(cache.getAzsSet('', 12), null);
  assert.equal(cache.size(), 0);
});

test('набор фото АЗС не течёт между порталами', () => {
  const cache = createRequiredPhotosCache();
  cache.setAzsSet('m1', 12, { photoTypeIds: [1, 2], azsTitle: 'АЗС 12' });
  assert.equal(cache.getAzsSet('m2', 12), null);
});

test('запись набора протухает по azsTtlMs', () => {
  let clock = 1000;
  const cache = createRequiredPhotosCache({ azsTtlMs: 500, now: () => clock });
  cache.setAzsSet('p', 12, { photoTypeIds: [1], azsTitle: 'АЗС' });
  clock = 1400;
  assert.deepEqual(cache.getAzsSet('p', 12).photoTypeIds, [1]);
  clock = 1501;
  assert.equal(cache.getAzsSet('p', 12), null);
});

test('типы фото живут дольше набора — у них свой TTL', () => {
  let clock = 0;
  const cache = createRequiredPhotosCache({ azsTtlMs: 100, typeTtlMs: 10_000, now: () => clock });
  cache.setAzsSet('p', 12, { photoTypeIds: [7], azsTitle: 'АЗС' });
  cache.setPhotoType('p', 7, { code: '7', title: 'Колонка', sort: 7 });
  clock = 500;
  assert.equal(cache.getAzsSet('p', 12), null, 'набор протух');
  assert.equal(cache.getPhotoType('p', 7).title, 'Колонка', 'тип ещё жив');
});

test('evictAzs убирает только свою запись', () => {
  const cache = createRequiredPhotosCache();
  cache.setAzsSet('p', 12, { photoTypeIds: [1], azsTitle: 'A' });
  cache.setAzsSet('p', 13, { photoTypeIds: [2], azsTitle: 'B' });
  cache.evictAzs('p', 12);
  assert.equal(cache.getAzsSet('p', 12), null);
  assert.equal(cache.getAzsSet('p', 13).azsTitle, 'B');
});

test('LRU вытесняет самую давнюю запись при переполнении', () => {
  const cache = createRequiredPhotosCache({ maxEntries: 2 });
  cache.setPhotoType('p', 1, { code: '1', title: 'A', sort: 1 });
  cache.setPhotoType('p', 2, { code: '2', title: 'B', sort: 2 });
  cache.getPhotoType('p', 1);                                   // 1 становится свежее 2
  cache.setPhotoType('p', 3, { code: '3', title: 'C', sort: 3 });
  assert.equal(cache.getPhotoType('p', 2), null, 'вытеснена 2, а не 1');
  assert.ok(cache.getPhotoType('p', 1));
});

import { readRequiredPhotos } from '../src/reports/reportsRoutes.js';

const makeClient = (counter) => ({
  async getCrmItem({ entityTypeId, id }) {
    counter.calls += 1;
    if (entityTypeId === 100) return { id, TITLE: 'АЗС 12', UF_PHOTO_SET: [7, 8, 9] };
    return { id, TITLE: `Тип ${id}` };
  }
});

const SETTINGS = {
  azs: { entityTypeId: 100, fields: { photoSet: 'UF_PHOTO_SET' } },
  photoType: { entityTypeId: 200 }
};
const CONTEXT = { memberId: 'm-cache-test', domain: 'cache.bitrix24.ru' };

test('вторая загрузка того же отчёта не ходит в Битрикс вовсе', async () => {
  const counter = { calls: 0 };
  const client = makeClient(counter);

  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '12', context: CONTEXT });
  const firstCalls = counter.calls;
  assert.equal(firstCalls, 4, '1 карточка АЗС + 3 типа фото');

  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '12', context: CONTEXT });
  assert.equal(counter.calls, firstCalls, 'второй вызов не добавил ни одного обращения');
});

test('без идентичности портала кэш не применяется — поведение прежнее', async () => {
  const counter = { calls: 0 };
  const client = makeClient(counter);
  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '77', context: {} });
  await readRequiredPhotos({ bitrixClient: client, settings: SETTINGS, azsId: '77', context: {} });
  assert.equal(counter.calls, 8, 'оба раза по 4 вызова, кэш не сработал');
});
