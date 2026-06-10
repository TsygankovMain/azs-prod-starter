import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedTick } from '../src/shared/guardedTick.js';

test('guardedTick: second tick while first is running returns {skipped:true} and calls runOnce only once', async () => {
  let runOnceCallCount = 0;
  let resolveFirst;

  const firstRunOncePromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const runOnce = async () => {
    runOnceCallCount += 1;
    // The first call hangs until we resolve it manually
    if (runOnceCallCount === 1) {
      await firstRunOncePromise;
      return { value: 'first' };
    }
    return { value: 'subsequent' };
  };

  const skips = [];
  const tick = createGuardedTick({
    runOnce,
    onSkip: () => skips.push(true)
  });

  // Start the first tick (it will hang)
  const firstTickPromise = tick();

  // Second tick while first is running — should skip immediately
  const secondResult = await tick();

  assert.deepEqual(secondResult, { skipped: true }, 'second tick must return {skipped:true}');
  assert.equal(runOnceCallCount, 1, 'runOnce called only once while first tick is running');
  assert.equal(skips.length, 1, 'onSkip called once');

  // Resolve first tick
  resolveFirst('done');
  const firstResult = await firstTickPromise;
  assert.deepEqual(firstResult, { value: 'first' }, 'first tick returns runOnce result');
});

test('guardedTick: guard is released after first tick completes; next tick runs runOnce again', async () => {
  let callCount = 0;

  const tick = createGuardedTick({
    runOnce: async () => {
      callCount += 1;
      return { n: callCount };
    }
  });

  const r1 = await tick();
  assert.deepEqual(r1, { n: 1 });

  // Guard should be released after tick completes
  const r2 = await tick();
  assert.deepEqual(r2, { n: 2 }, 'after guard released, next tick runs runOnce again');
  assert.equal(callCount, 2);
});

test('guardedTick: guard is released even when runOnce throws', async () => {
  let callCount = 0;

  const tick = createGuardedTick({
    runOnce: async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('run failed');
      return { n: callCount };
    }
  });

  await assert.rejects(() => tick(), /run failed/);
  assert.equal(callCount, 1);

  // Guard should be released after the throw
  const r2 = await tick();
  assert.deepEqual(r2, { n: 2 });
  assert.equal(callCount, 2);
});

test('guardedTick: default onSkip is a no-op (does not throw when not provided)', async () => {
  let resolveFirst;
  const firstPromise = new Promise((r) => { resolveFirst = r; });

  const tick = createGuardedTick({
    runOnce: async () => { await firstPromise; return 'ok'; }
    // no onSkip provided
  });

  const firstTickP = tick();
  // second tick with no onSkip — must not throw
  const secondResult = await tick();
  assert.deepEqual(secondResult, { skipped: true });

  resolveFirst();
  await firstTickP;
});
