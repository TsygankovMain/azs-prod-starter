import express from 'express';

/**
 * diagMiddleware — общие куски монтирования /api/diag, вынесенные из
 * server.js в отдельный модуль (ревью, S2).
 *
 * До этого извлечения tests/diagParserBypass.test.js и
 * tests/diagBootGuard.test.js писали СВОИ копии этой же логики — удаление
 * или порча настоящей мидлвари в server.js оставляла тесты зелёными, хотя
 * проверяемое поведение исчезало. Теперь server.js и оба тестовых файла
 * используют один и тот же код.
 */

/** Пути, для которых глобальный express.json() (дефолтный потолок 100 КБ)
 *  должен уступить собственным парсерам роутера — 512 КБ для бандла,
 *  1 МБ для echo-пробы (см. DIAG_JSON_LIMIT/DIAG_ECHO_LIMIT в diagRoutes.js,
 *  которые применяются НИЖЕ по цепочке, уже внутри самого роутера). */
export const DIAG_OWN_PARSER_PATHS = ['/api/diag/report', '/api/diag/echo'];

/** Пути внутри /api/diag, которые монтируются с сигнатурным (без БД) JWT-
 *  гвардом вместо полного — см. S1 и createVerifyTokenSignatureOnly в
 *  utils/verifyToken.js. /ping и /echo меряют канал оператора, а не нашу БД. */
export const DIAG_SIGNATURE_ONLY_PATHS = ['/ping', '/echo'];

/**
 * Обходит глобальный JSON-парсер для диагностических путей с увеличенным
 * лимитом тела. Для всех остальных маршрутов поведение приложения не
 * меняется — тело по-прежнему разбирает jsonParser (по умолчанию
 * express.json()).
 */
export const createJsonParserBypass = ({
  jsonParser = express.json(),
  bypassPaths = DIAG_OWN_PARSER_PATHS
} = {}) => {
  const bypassSet = new Set(bypassPaths);
  return (req, res, next) => {
    if (bypassSet.has(req.path)) return next();
    return jsonParser(req, res, next);
  };
};

/**
 * Фолбэк на /api/diag/*, когда diagStore === null (СУБД не PostgreSQL —
 * см. server.js). Отвечает в том же JSON-контракте, что и остальное
 * приложение: голый HTML-404 от Express фронтенд читает как SyntaxError и
 * показывает оператору сбой вместо понятного «диагностика недоступна».
 */
export const createDiagUnavailableHandler = () => (_req, res) => {
  res.status(503).json({ error: 'diag_unavailable' });
};

/**
 * Fix round (ревью, live-run на реальном сервере): express.json({limit})/
 * express.raw({limit}) в diagRoutes.js бросают ДО обработчика маршрута —
 * их next(err) уходит мимо try/catch внутри router.post('/report', ...) и
 * router.post('/echo', ...). Без этой мидлвари такой запрос (битый JSON,
 * тело сверх лимита) долетает до дефолтного обработчика ошибок Express,
 * который — при не заданном NODE_ENV (а в этом проекте он не задан, это
 * реальный деплой-дефолт, не dev-артефакт) — отвечает HTML-страницей с
 * полным стеком и абсолютными путями сервера. Тот же класс дефекта, что и
 * уже исправленный throw в sanitizeBundle, только источник другой: там
 * бросал наш код внутри обработчика, здесь — сам парсер до обработчика.
 *
 * Мидлварь ошибок Express опознаёт по arity (4 аргумента) — все четыре
 * обязаны присутствовать в сигнатуре, даже неиспользуемые.
 */
export const createDiagErrorHandler = () => (error, _req, res, _next) => {
  const status = Number(error?.status || error?.statusCode) || 400;
  const code = error?.type === 'entity.too.large' ? 'payload_too_large' : 'invalid_request_body';
  console.error(JSON.stringify({ event: 'diag_request_rejected', code, status, message: error?.message }));
  res.status(status).json({ error: code });
};
