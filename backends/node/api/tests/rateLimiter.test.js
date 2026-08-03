import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/shared/rateLimiter.js';

const makeHarness = () => {
  let clock = 0;
  const sleeps = [];
  return {
    now: () => clock,
    advance: (ms) => { clock += ms; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    sleeps
  };
};

test('первые burst обращений проходят без ожидания', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 1.4, burst: 3, now: h.now, sleep: h.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(h.sleeps, [], 'запаса хватило на три');
});

test('четвёртое обращение ждёт пополнения', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 3, now: h.now, sleep: h.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.sleeps[0], 500, 'при 2/с один токен копится 500 мс');
});

test('токены копятся со временем, но не выше burst', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 3, now: h.now, sleep: h.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  h.advance(60_000);
  assert.equal(limiter.available(), 3, 'за минуту накопилось бы 120, но потолок — burst');
});

test('penalize замораживает выдачу на указанный срок', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 5, now: h.now, sleep: h.sleep });
  limiter.penalize(3000);
  await limiter.acquire();
  assert.equal(h.sleeps[0], 3000, 'Retry-After от портала важнее накопленных токенов');
});

test('penalize не сокращает уже назначенную паузу', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 5, now: h.now, sleep: h.sleep });
  limiter.penalize(5000);
  limiter.penalize(1000);
  await limiter.acquire();
  assert.equal(h.sleeps[0], 5000, 'вторая, более мягкая пауза не отменяет первую');
});

test('ограничитель общий: два потребителя делят один бюджет', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 2, now: h.now, sleep: h.sleep });
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.equal(h.sleeps.length, 1, 'третий подождал, хотя пришёл из другого воркера');
});

// Добавлено сверх брифа при мутационной проверке (Шаг 5): мутация «в acquire
// вызывать takeOne() напрямую, без queue» не красит тест выше — при burst:2
// среди трёх синхронных вызовов только третий вообще доходит до await
// (первые два всегда успевают синхронно декрементировать до третьего), поэтому
// реального пересечения двух ожиданий не возникает и гонка не проявляется.
// Здесь burst:1 — тогда из трёх конкурентных вызовов ждать обязаны оба
// «лишних», и без сериализации второй вызов успевает получить токен,
// пополненный ожиданием первого, до того как сам первый его вычтет — то есть
// ровно тот дефект, что описан в комментариях модуля: «два одновременных
// вызова оба увидели бы один и тот же запас токенов».
test('ограничитель сериализован: при burst 1 оба лишних конкурентных вызова ждут по отдельности', async () => {
  const h = makeHarness();
  const limiter = createRateLimiter({ ratePerSec: 2, burst: 1, now: h.now, sleep: h.sleep });
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.deepEqual(h.sleeps, [500, 500], 'первый — бесплатно, а двое остальных обязаны каждый дождаться своего пополнения');
});

// Раунд правок 1 (ревью нашло Critical): frozenUntil читался один раз при
// входе в takeOne(). penalize(), прилетевший, пока этот же вызов уже спал
// (неважно, на ожидании токена или на самой заморозке), терялся — вызов
// просыпался, забирал токен и возвращал управление внутри окна заморозки.
// Сценарий А (тест ревьюера, дословно): штраф прилетает во время сна на
// ожидании токена.
test('penalize во время ожидания токена не должен игнорироваться уже стартовавшим acquire()', async () => {
  const h = makeHarness();
  let limiter, injected = false;
  const sleep = async (ms) => {
    h.sleeps.push(ms);
    if (!injected && ms === 500) { injected = true; limiter.penalize(3000); }
    h.advance(ms);
  };
  limiter = createRateLimiter({ ratePerSec: 2, burst: 1, now: h.now, sleep });
  await limiter.acquire();
  await limiter.acquire();
  assert.ok(h.now() >= 3000, `acquire() вернулся на t=${h.now()}, хотя штраф действует до t=3000`);
});

// Сценарий Б (не покрыт тестом ревьюера, добавлен отдельно): штраф прилетает
// во время сна на уже идущей заморозке (а не на ожидании токена) и обязан её
// продлить, а не быть проигнорированным.
test('penalize во время сна на уже идущей заморозке продлевает её, а не игнорируется', async () => {
  const h = makeHarness();
  let limiter, injected = false;
  const sleep = async (ms) => {
    h.sleeps.push(ms);
    if (!injected && ms === 1000) { injected = true; limiter.penalize(5000); }
    h.advance(ms);
  };
  limiter = createRateLimiter({ ratePerSec: 2, burst: 5, now: h.now, sleep });
  limiter.penalize(1000);
  await limiter.acquire();
  assert.ok(h.now() >= 5000, `acquire() вернулся на t=${h.now()}, хотя продление держит заморозку до t=5000`);
});
