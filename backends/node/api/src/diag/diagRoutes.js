import express from 'express';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { sanitizeBundle, generateDiagCode } from './sanitizeBundle.js';

export const DIAG_JSON_LIMIT = '512kb';
export const DIAG_ECHO_LIMIT = '1mb';

/**
 * diagRoutes — приём диагностических бандлов и активные пробы.
 *
 * /ping и /echo намеренно не делают ничего тяжёлого: их задача — измерить
 * сеть оператора, а не нашу БД. Поэтому они не обращаются к стору и должны
 * монтироваться без attachAccessContext (см. Task 6).
 */
export const createDiagRouter = ({
  store,
  randomBytes = nodeRandomBytes,
  logger = console,
  serverSelfCheck = null,
  // Task 12: пост в дежурный чат — карточка + бандл файлом. Best-effort и
  // не блокирует ответ оператору (см. вызов ниже, в конце POST /report):
  // отсутствие настройки (chatNotifier === null, как в существующих тестах
  // этого роутера) — не ошибка, диагностика просто не сообщается в чат.
  chatNotifier = null
}) => {
  const router = express.Router();

  router.get('/ping', (_req, res) => {
    res.json({ t: Date.now() });
  });

  router.post('/echo', express.raw({ type: '*/*', limit: DIAG_ECHO_LIMIT }), (req, res) => {
    const startedAt = Date.now();
    // Если тело уже разобрано другим парсером, Buffer недоступен — берём
    // объявленную длину. Молча ответить 0 нельзя: ноль читается как «канал
    // мёртв», и замер становится вредным, а не бесполезным.
    const bytes = Buffer.isBuffer(req.body)
      ? req.body.length
      : Number(req.headers['content-length'] || 0) || 0;
    res.json({ bytes, serverMs: Date.now() - startedAt, buffered: Buffer.isBuffer(req.body) });
  });

  router.post('/report', express.json({ limit: DIAG_JSON_LIMIT }), async (req, res) => {
    // sanitizeBundle разбирает произвольный JSON из браузера: поле вроде
    // toString может уронить внутреннюю коерсию в String()/Number(). Ничего
    // не должно долетать до клиента как HTML-страница Express со стеком.
    let result;
    let code;
    try {
      result = sanitizeBundle(req.body);
      code = generateDiagCode(randomBytes(6));
    } catch (error) {
      logger.error('diag_report_malformed', { message: error.message });
      return res.status(400).json({ error: 'diag_bundle_unprocessable' });
    }
    if (!result.ok) {
      logger.warn('diag_report_rejected', { reason: result.error });
      return res.status(400).json({ error: result.error });
    }

    const { bundle, sizeBytes } = result;

    // Серверный срез — best-effort и никогда не роняет приём бандла: клиентская
    // половина ценна сама по себе, терять её из-за зависшего Диска нельзя.
    // Реализация — Task 11; до неё serverSelfCheck === null.
    let serverSlice = null;
    if (serverSelfCheck) {
      try {
        serverSlice = await serverSelfCheck.run();
      } catch (error) {
        logger.warn('diag_server_slice_failed', { code, message: error.message });
      }
    }

    // Коллизия кода маловероятна (31^6), но UNIQUE-нарушение не должно
    // превращать корректную отправку в 500 — пробуем новый код.
    const isDuplicateCode = (error) => /duplicate key|unique/i.test(String(error?.message || ''));

    let row = null;
    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      try {
        row = await store.insert({
          code,
          diagSessionId: bundle.diagSessionId || null,
          userId: Number(req.user?.user_id || req.user?.id || 0) || null,
          azsId: bundle.user?.azsId || null,
          reportId: bundle.user?.reportId || null,
          trigger: bundle.trigger,
          sizeBytes,
          bundle,
          serverSlice
        });
        break;
      } catch (error) {
        if (!isDuplicateCode(error) || attempt === 3) {
          logger.error('diag_report_failed', { code, message: error.message });
          return res.status(500).json({ error: 'diag_report_failed' });
        }
        logger.warn('diag_code_collision', { attempt });
        code = generateDiagCode(randomBytes(6));
      }
    }

    logger.info('diag_report_stored', {
      code, sizeBytes, trigger: bundle.trigger, azsId: bundle.user?.azsId || null
    });

    // Store first, post best-effort: бандл уже в базе (row выше), ответ
    // оператору уже решён — пост в чат команды не должен ни задержать его,
    // ни тем более его изменить. Поэтому НЕ await: notify() запускается и
    // ответ уходит сразу же. .catch() — подстраховка на случай, если сам
    // notifier нарушит свой контракт «никогда не бросает» (см.
    // diagChatNotifier.js): без неё такой сбой был бы unhandledRejection,
    // а не тихим логом.
    if (chatNotifier && typeof chatNotifier.notify === 'function') {
      Promise.resolve(chatNotifier.notify({ code, bundle, serverSlice }))
        .catch((error) => {
          logger.error('diag_chat_notify_threw', { code, message: error?.message || String(error) });
        });
    }

    return res.json({ diagId: row?.id ?? null, code });
  });

  // Fix round (ревью, BLOCKING 2): чтение бандлов (device, тексты ошибок,
  // сетевой лог, серверный срез — домен портала, member id, наличие OAuth-
  // токена) раньше не требовало ничего, кроме валидного JWT — любой
  // авторизованный оператор станции мог прочитать чужие диагностики. Гейт —
  // тот же паттерн, что и в server.js:534 (capabilities.settings), только
  // не на уровне монтирования (там сидит и POST /report, который обязан
  // остаться доступен обычному оператору), а на уровне самих read-роутов.
  const requireSettingsCapability = (req, res) => {
    if (!req.accessContext?.capabilities?.settings) {
      res.status(403).json({
        error: 'forbidden',
        message: 'Admin access required'
      });
      return false;
    }
    return true;
  };

  router.get('/reports', async (req, res) => {
    if (!requireSettingsCapability(req, res)) return;
    try {
      const items = await store.list({
        azsId: String(req.query.azsId || ''),
        dateFrom: String(req.query.dateFrom || ''),
        dateTo: String(req.query.dateTo || ''),
        limit: Number(req.query.limit || 50)
      });
      return res.json({ items });
    } catch (error) {
      logger.error('diag_list_failed', { message: error.message });
      return res.status(500).json({ error: 'diag_list_failed' });
    }
  });

  router.get('/reports/:code', async (req, res) => {
    if (!requireSettingsCapability(req, res)) return;
    try {
      const row = await store.getByCode(req.params.code);
      if (!row) return res.status(404).json({ error: 'diag_report_not_found' });
      return res.json({ item: row });
    } catch (error) {
      logger.error('diag_get_failed', { code: req.params.code, message: error.message });
      return res.status(500).json({ error: 'diag_get_failed' });
    }
  });

  return router;
};

export default createDiagRouter;
