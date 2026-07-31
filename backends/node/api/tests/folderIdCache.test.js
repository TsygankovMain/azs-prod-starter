import test from 'node:test';
import assert from 'node:assert/strict';
import { createFolderIdCache, buildPortalKey } from '../src/disk/folderIdCache.js';

test('buildPortalKey combines memberId and domain, lowercasing domain', () => {
  assert.equal(buildPortalKey({ memberId: 'm1', domain: 'Example.Bitrix24.ru' }), 'm1::example.bitrix24.ru');
});

test('buildPortalKey returns empty string when both memberId and domain are missing', () => {
  assert.equal(buildPortalKey({}), '');
  assert.equal(buildPortalKey(), '');
  assert.equal(buildPortalKey({ userId: 42, authId: 'abc' }), '');
});

test('buildPortalKey differs for different portals and is stable for the same portal', () => {
  const a1 = buildPortalKey({ memberId: 'm1', domain: 'a.bitrix24.ru' });
  const a2 = buildPortalKey({ memberId: 'm1', domain: 'a.bitrix24.ru' });
  const b = buildPortalKey({ memberId: 'm2', domain: 'b.bitrix24.ru' });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('folderIdCache: basic get/set round trip', () => {
  const cache = createFolderIdCache();
  assert.equal(cache.get('portal-1', 10, '2026-07/31/12_Station'), undefined);

  cache.set('portal-1', 10, '2026-07/31/12_Station', 4242);
  assert.equal(cache.get('portal-1', 10, '2026-07/31/12_Station'), 4242);
  assert.equal(cache.size, 1);
});

test('folderIdCache: evict removes exactly the targeted entry', () => {
  const cache = createFolderIdCache();
  cache.set('portal-1', 10, 'path/a', 1);
  cache.set('portal-1', 10, 'path/b', 2);

  cache.evict('portal-1', 10, 'path/a');

  assert.equal(cache.get('portal-1', 10, 'path/a'), undefined);
  assert.equal(cache.get('portal-1', 10, 'path/b'), 2);
  assert.equal(cache.size, 1);
});

test('folderIdCache: same (rootFolderId, path) under a different portalKey is a separate entry', () => {
  const cache = createFolderIdCache();
  cache.set('portal-A', 10, '2026-07/31/12_Station', 111);
  cache.set('portal-B', 10, '2026-07/31/12_Station', 222);

  assert.equal(cache.get('portal-A', 10, '2026-07/31/12_Station'), 111);
  assert.equal(cache.get('portal-B', 10, '2026-07/31/12_Station'), 222);

  // Evicting one portal's entry must not touch the other portal's entry for
  // the identical (rootFolderId, path) pair — this is the cross-portal
  // isolation the whole cache design exists to guarantee.
  cache.evict('portal-A', 10, '2026-07/31/12_Station');
  assert.equal(cache.get('portal-A', 10, '2026-07/31/12_Station'), undefined);
  assert.equal(cache.get('portal-B', 10, '2026-07/31/12_Station'), 222);
});

test('folderIdCache: a falsy/empty portalKey is never cached (get always misses, set is a no-op)', () => {
  const cache = createFolderIdCache();
  cache.set('', 10, 'path/a', 999);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('', 10, 'path/a'), undefined);
  cache.evict('', 10, 'path/a'); // must not throw
});

test('folderIdCache: different rootFolderId with the same path and portal is a separate entry', () => {
  const cache = createFolderIdCache();
  cache.set('portal-1', 10, 'same/path', 1);
  cache.set('portal-1', 20, 'same/path', 2);

  assert.equal(cache.get('portal-1', 10, 'same/path'), 1);
  assert.equal(cache.get('portal-1', 20, 'same/path'), 2);
});

test('folderIdCache: entries expire after ttlMs using an injected clock', () => {
  let currentTime = 1_000_000;
  const cache = createFolderIdCache({ ttlMs: 1000, now: () => currentTime });

  cache.set('portal-1', 10, 'path', 5);
  assert.equal(cache.get('portal-1', 10, 'path'), 5);

  currentTime += 999;
  assert.equal(cache.get('portal-1', 10, 'path'), 5, 'not yet expired just under the TTL');

  currentTime += 2;
  assert.equal(cache.get('portal-1', 10, 'path'), undefined, 'expired once TTL has elapsed');
  assert.equal(cache.size, 0, 'expired entry is dropped from storage, not just hidden');
});

test('folderIdCache: size never exceeds maxEntries no matter how many distinct keys are inserted', () => {
  const cache = createFolderIdCache({ maxEntries: 5 });

  for (let i = 0; i < 500; i += 1) {
    cache.set('portal-1', 10, `2026-07/31/station-${i}`, i);
    assert.ok(cache.size <= 5, `size ${cache.size} exceeded maxEntries after inserting key ${i}`);
  }

  assert.equal(cache.size, 5);
});

test('folderIdCache: exceeding maxEntries evicts the oldest (least recently used) entry first', () => {
  const cache = createFolderIdCache({ maxEntries: 2 });

  cache.set('portal-1', 10, 'a', 1);
  cache.set('portal-1', 10, 'b', 2);
  cache.set('portal-1', 10, 'c', 3); // should push out 'a', the oldest

  assert.equal(cache.get('portal-1', 10, 'a'), undefined);
  assert.equal(cache.get('portal-1', 10, 'b'), 2);
  assert.equal(cache.get('portal-1', 10, 'c'), 3);
});

test('folderIdCache: reading an entry (get) protects it from eviction ahead of one that was not read', () => {
  const cache = createFolderIdCache({ maxEntries: 2 });

  cache.set('portal-1', 10, 'a', 1);
  cache.set('portal-1', 10, 'b', 2);
  // Touch 'a' so it becomes the most-recently-used, leaving 'b' as the
  // least-recently-used entry.
  assert.equal(cache.get('portal-1', 10, 'a'), 1);

  cache.set('portal-1', 10, 'c', 3); // must evict 'b', not 'a'

  assert.equal(cache.get('portal-1', 10, 'a'), 1, 'recently-read entry must survive');
  assert.equal(cache.get('portal-1', 10, 'b'), undefined, 'least-recently-used entry must be evicted');
  assert.equal(cache.get('portal-1', 10, 'c'), 3);
});

test('folderIdCache: re-setting an existing key updates its value without growing the cache', () => {
  const cache = createFolderIdCache({ maxEntries: 10 });
  cache.set('portal-1', 10, 'a', 1);
  cache.set('portal-1', 10, 'a', 2);

  assert.equal(cache.size, 1);
  assert.equal(cache.get('portal-1', 10, 'a'), 2);
});
