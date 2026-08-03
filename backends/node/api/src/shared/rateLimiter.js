// Токен-бакет для общего темпа обращений к порталу.
//
// Зачем отдельным модулем и почему общий: сегодня темпом не управляет никто —
// каждый телефон и каждый воркер гонят свои цепочки, не зная друг о друге, а
// лимит портала (2 запроса в секунду) общий. Существующий crmSyncWorker.drain()
// вообще крутит tick() без пауз. Этот объект — единственное место, где виден
// суммарный расход, поэтому экземпляр обязан быть ОДИН на процесс и делиться
// между всеми воркерами.
//
// acquire() последовательно сериализует ожидающих через цепочку промисов:
// без этого два одновременных вызова оба увидели бы «токен есть» и выпустили
// бы два запроса на один токен.

export const createRateLimiter = ({
  ratePerSec = 1.4,
  burst = 3,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) => {
  if (!(ratePerSec > 0)) throw new Error('ratePerSec must be positive');
  if (!(burst > 0)) throw new Error('burst must be positive');

  let tokens = burst;
  let lastRefillAt = now();
  let frozenUntil = 0;
  let queue = Promise.resolve();

  const refill = () => {
    const at = now();
    const elapsedMs = at - lastRefillAt;
    if (elapsedMs > 0) {
      tokens = Math.min(burst, tokens + (elapsedMs / 1000) * ratePerSec);
      lastRefillAt = at;
    }
  };

  const takeOne = async () => {
    // Раунд правок 1 (ревью нашло Critical): frozenUntil нельзя проверять
    // один раз при входе. Пока этот вызов спит (неважно, на ожидании токена
    // или на самой заморозке), конкурентный penalize() из другого воркера
    // может установить или продлить заморозку — и линейный проход из одного
    // if/if эту новость никогда не увидит, так как после сна сразу списывает
    // токен и возвращает управление. Поэтому — цикл, перепроверяющий обе
    // причины ждать заново после КАЖДОГО пробуждения, а не только на входе.
    //
    // Завершение гарантировано: обе ветки спят только строго положительное
    // время (guard `> 0` перед сном; waitMs — Math.ceil от строго
    // положительной величины, значит не может дать 0), поэтому каждая
    // итерация реально продвигает now() вперёд и не может крутиться пустым
    // циклом на нулевых интервалах. Единственный способ продлить цикл —
    // конкурентные penalize() с растущим горизонтом, прилетающие, пока этот
    // вызов уже спит; это конечное число реальных внешних событий (штрафов
    // от портала), а не дефект цикла.
    for (;;) {
      refill();

      // Штраф от портала (Retry-After) важнее накопленных токенов: продолжать
      // слать в этот момент — усиливать давление ровно тогда, когда портал
      // просит его снизить.
      const freezeMs = frozenUntil - now();
      if (freezeMs > 0) {
        await sleep(freezeMs);
        continue;
      }

      if (tokens < 1) {
        const waitMs = Math.ceil(((1 - tokens) / ratePerSec) * 1000);
        await sleep(waitMs);
        continue;
      }

      break;
    }
    tokens -= 1;
  };

  return {
    // Сериализация обязательна: параллельные acquire() без неё оба увидели бы
    // один и тот же запас и выпустили бы два запроса на один токен.
    acquire() {
      const next = queue.then(takeOne, takeOne);
      queue = next.catch(() => {});
      return next;
    },
    // Только продлевает заморозку, никогда не сокращает: более мягкий ответ
    // от другого запроса не должен отменять более строгий.
    penalize(ms) {
      const until = now() + Math.max(0, Number(ms) || 0);
      if (until > frozenUntil) frozenUntil = until;
    },
    available() {
      refill();
      return tokens;
    }
  };
};

export default createRateLimiter;
