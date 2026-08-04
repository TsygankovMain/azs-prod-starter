// TTL-кэш поверх settingsStore.read(), с дедупликацией конкурентных промахов.
//
// Извлечён из photoPublisher.js (I1, раунд правок 2 финального ревью) в общий
// модуль — второй потребитель (buildCrmSyncRunner, reportsRoutes.js) нуждается
// в ТОЙ ЖЕ технике по той же причине, и копипаста грозила бы ровно тем, чего
// эта пара уже избегает внутри себя: рассинхроном двух копий одной и той же
// логики со временем. Каждый потребитель держит СВОЙ приватный инстанс (см.
// комментарии в photoPublisher.js и buildCrmSyncRunner) — общий инстанс на
// оба без причины связал бы TTL и частоту чтения двух разных подсистем
// (публикация фото vs CRM-синк), которым незачем зависеть друг от друга.
//
// Зачем кэш вообще: composite settingsStore пробует ПОРТАЛ первым
// (app.option.get) и не кэширует ничего сам — каждый settingsStore.read() без
// этой обёртки означает отдельный, реальный, ничем не ограниченный запрос к
// Битриксу. На фоновом цикле (претендент на "один read на партию", а не "один
// read на каждую единицу работы") это быстро превращается в лишнюю нагрузку
// на портал, который и так у него в приоритете.
//
// inFlight дедуплицирует КОНКУРЕНТНЫЕ промахи: несколько параллельных read()
// (например, несколько задач одной пачки, поднявшихся после простоя) обязаны
// дождаться ОДНОГО settingsStore.read() и разделить его результат, а не
// каждый сделать свой — иначе кэш не спасает именно в момент всплеска
// нагрузки, ради которого он и нужен.
export const createSettingsCache = ({ settingsStore, ttlMs, now = () => Date.now() }) => {
  let cached;
  let expiresAt = 0;
  let inFlight = null;

  return {
    async read() {
      if (cached !== undefined && now() < expiresAt) {
        return cached;
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = (async () => {
        try {
          const settings = await settingsStore.read();
          cached = settings;
          expiresAt = now() + ttlMs;
          return settings;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    }
  };
};

export default createSettingsCache;
