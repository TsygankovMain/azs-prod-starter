import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoNamingResolver, normalizeAzsCode } from '../src/reports/photoNamingResolver.js';

// ---------------------------------------------------------------------------
// BUG-8733. Резолвер имён для файлов и папок фотоотчёта.
//
// Фикстуры — с боевого портала ОРТК: реестр АЗС (entityTypeId=1054) содержит
// 75 карточек, заголовок карточки и есть номер станции («486», «1102»,
// «33231»); одна карточка озаглавлена «АЗС 33249», несколько — нечисловые
// («Офис», «АГЗС (Одинцово)»). Справочник типов фото — entityTypeId=1112,
// заголовки вида «35. Доска визуального управления».
// ---------------------------------------------------------------------------

const SETTINGS = { azs: { entityTypeId: 1054 }, photoType: { entityTypeId: 1112 } };
const CONTEXT = { memberId: 'member-ortk', domain: 'ortk.bitrix24.ru' };

const silentLogger = { warn() {}, error() {}, info() {}, debug() {} };

const makeClient = (titles, { fail = null } = {}) => {
  const calls = [];
  return {
    calls,
    async getCrmItem({ entityTypeId, id }) {
      calls.push({ entityTypeId, id });
      if (fail && fail()) throw new Error('Bitrix REST crm.item.get error: QUERY_LIMIT_EXCEEDED');
      const title = titles[`${entityTypeId}:${id}`];
      return title === undefined ? null : { id, title };
    }
  };
};

// ---------------------------------------------------------------------------
// normalizeAzsCode
// ---------------------------------------------------------------------------

test('normalizeAzsCode срезает приставку «АЗС» и оставляет только код станции', () => {
  assert.equal(normalizeAzsCode('АЗС 33249'), '33249');
  assert.equal(normalizeAzsCode('АЗС33249'), '33249');
  assert.equal(normalizeAzsCode('АЗС № 486'), '486');
});

test('normalizeAzsCode не трогает заголовки, которые лишь ПОХОЖИ на приставку', () => {
  // Якорь на начало строки плюс точная последовательность букв: «АГЗС» — это
  // другое слово, и обрезать у него «ГЗС» было бы порчей имени.
  assert.equal(normalizeAzsCode('АГЗС (Одинцово)'), 'АГЗС (Одинцово)');
  assert.equal(normalizeAzsCode('Нефтебаза'), 'Нефтебаза');
  assert.equal(normalizeAzsCode('Офис'), 'Офис');
  assert.equal(normalizeAzsCode('486'), '486');
});

test('normalizeAzsCode не превращает заголовок в пустую строку', () => {
  // Заголовок ровно «АЗС»: после среза не осталось бы ничего, а пустое имя
  // отправило бы buildPhotoFileName обратно к id элемента — хуже некрасивого.
  assert.equal(normalizeAzsCode('АЗС'), 'АЗС');
  assert.equal(normalizeAzsCode('   '), '');
  assert.equal(normalizeAzsCode(null), '');
});

test('normalizeAzsCode обрезает хвостовые пробелы заголовка (в реестре есть «2130 »)', () => {
  assert.equal(normalizeAzsCode('2130 '), '2130');
});

// ---------------------------------------------------------------------------
// Кэш
// ---------------------------------------------------------------------------

test('успешный резолв кэшируется на весь TTL и перечитывается только после него', async () => {
  let clock = 0;
  const client = makeClient({ '1054:104': '486' });
  const resolver = createPhotoNamingResolver({
    bitrixClient: client,
    azsTtlMs: 1000,
    now: () => clock,
    logger: silentLogger
  });

  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '486');
  assert.equal(client.calls.length, 1);

  clock += 900; // ВНУТРИ TTL
  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '486');
  assert.equal(client.calls.length, 1, 'внутри TTL повторного похода в Битрикс быть не должно — иначе кэша нет вовсе');

  clock += 200; // суммарно 1100 — ЗА TTL
  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '486');
  assert.equal(client.calls.length, 2, 'после истечения TTL переименование карточки обязано стать видимым');
});

test('отказ справочника кэшируется КОРОТКО: не долбим портал на каждое фото, но и не помним пустое имя полсуток', async () => {
  let clock = 0;
  let broken = true;
  const client = makeClient({ '1054:104': '486' }, { fail: () => broken });
  const resolver = createPhotoNamingResolver({
    bitrixClient: client,
    azsTtlMs: 6 * 60 * 60 * 1000,
    negativeTtlMs: 60_000,
    now: () => clock,
    logger: silentLogger
  });

  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '');
  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '');
  assert.equal(client.calls.length, 1, 'пока портал лежит, повторять запрос на каждое фото бессмысленно');

  broken = false;
  clock += 61_000; // отрицательный TTL истёк
  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '486');
  assert.equal(client.calls.length, 2, 'через минуту после починки портала имя обязано стать настоящим');
});

test('конкурентные промахи по одному ключу дают ОДИН запрос к Битриксу, а не по одному на воркера', async () => {
  const resolvers = [];
  const client = {
    calls: 0,
    async getCrmItem() {
      this.calls += 1;
      await new Promise((resolve) => { resolvers.push(resolve); });
      return { id: 104, title: '486' };
    }
  };
  const resolver = createPhotoNamingResolver({ bitrixClient: client, logger: silentLogger });

  const a = resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT });
  await new Promise((resolve) => setImmediate(resolve));
  const b = resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.calls, 1, 'три воркера публикации на одном отчёте не должны втроём спрашивать одно и то же');

  for (const resolve of resolvers) resolve();
  assert.deepEqual(await Promise.all([a, b]), ['486', '486']);
});

test('кэш не смешивает порталы: одинаковый id на другом портале резолвится заново', async () => {
  const client = makeClient({ '1054:104': '486' });
  const resolver = createPhotoNamingResolver({ bitrixClient: client, logger: silentLogger });

  await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT });
  await resolver.resolveAzsName({
    settings: SETTINGS,
    azsId: 104,
    context: { memberId: 'member-other', domain: 'other.bitrix24.ru' }
  });

  assert.equal(client.calls.length, 2, 'ключ кэша обязан включать идентичность портала — иначе клиент увидит чужие названия');
});

test('неопознанный портал не кэшируется вовсе (а не кладётся в общий безымянный бакет)', async () => {
  const client = makeClient({ '1054:104': '486' });
  const resolver = createPhotoNamingResolver({ bitrixClient: client, logger: silentLogger });

  await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: {} });
  await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: {} });

  assert.equal(client.calls.length, 2);
  assert.equal(resolver.size, 0, 'запись без идентичности портала не имеет права попасть в кэш');
});

// ---------------------------------------------------------------------------
// Вырожденные конфигурации — пустая строка, а не исключение
// ---------------------------------------------------------------------------

test('ненастроенный справочник, неизвестный id и клиент без getCrmItem дают пустое имя без единого запроса', async () => {
  const client = makeClient({ '1054:104': '486' });
  const resolver = createPhotoNamingResolver({ bitrixClient: client, logger: silentLogger });

  assert.equal(await resolver.resolveAzsName({ settings: {}, azsId: 104, context: CONTEXT }), '');
  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 'нет-цифр', context: CONTEXT }), '');
  assert.equal(client.calls.length, 0);

  const noCrm = createPhotoNamingResolver({ bitrixClient: { diskApi: {} }, logger: silentLogger });
  assert.equal(await noCrm.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '');
});

test('карточка есть, но заголовок пуст — пустое имя, и оно НЕ залипает надолго', async () => {
  let clock = 0;
  const client = makeClient({ '1112:70': '   ' });
  const resolver = createPhotoNamingResolver({
    bitrixClient: client,
    typeTtlMs: 12 * 60 * 60 * 1000,
    negativeTtlMs: 60_000,
    now: () => clock,
    logger: silentLogger
  });

  assert.equal(await resolver.resolvePhotoTypeTitle({ settings: SETTINGS, photoCode: '70', context: CONTEXT }), '');
  clock += 61_000;
  await resolver.resolvePhotoTypeTitle({ settings: SETTINGS, photoCode: '70', context: CONTEXT });
  assert.equal(client.calls.length, 2, 'пустой заголовок — такой же «не узнали», как и отказ портала');
});

test('название типа фото отдаётся как есть — числовую приставку срезает уже buildPhotoCategory', async () => {
  const client = makeClient({ '1112:70': '35. Доска визуального управления' });
  const resolver = createPhotoNamingResolver({ bitrixClient: client, logger: silentLogger });

  assert.equal(
    await resolver.resolvePhotoTypeTitle({ settings: SETTINGS, photoCode: '70', context: CONTEXT }),
    '35. Доска визуального управления'
  );
});

test('обращение к справочнику берёт токен ограничителя и передаёт ему retryAfterMs из ответа портала', async () => {
  const acquired = [];
  const penalties = [];
  const limiter = {
    async acquire() { acquired.push(1); },
    penalize(ms) { penalties.push(ms); }
  };
  const client = {
    async getCrmItem() {
      const error = new Error('Bitrix REST crm.item.get failed with HTTP 503');
      error.retryAfterMs = 4000;
      throw error;
    }
  };
  const resolver = createPhotoNamingResolver({ bitrixClient: client, limiter, logger: silentLogger });

  assert.equal(await resolver.resolveAzsName({ settings: SETTINGS, azsId: 104, context: CONTEXT }), '');
  assert.equal(acquired.length, 1);
  assert.deepEqual(penalties, [4000], 'просьбу портала подождать нельзя терять только потому, что ошибку мы проглотили');
});
