import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { buildAuthContextKey } from '../src/auth/authContextStore.js';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Разбирает заголовок Authorization и проверяет подпись/срок действия JWT.
 * Общая часть для createVerifyToken (полный гвард, ниже идёт в БД за
 * bitrixContext) и createVerifyTokenSignatureOnly (S1-фикс: гвард без БД для
 * /ping и /echo) — единственное место, где вызывается jwt.verify, чтобы оба
 * гварда проверяли токен одинаково и ничего не дублировало крипто-логику.
 */
const verifyBearerSignature = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return { error: { status: 401, body: { error: 'Authorization header missing' } } };
  }

  const tokenParts = authHeader.split(' ');
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    return { error: { status: 401, body: { error: 'Invalid token format' } } };
  }

  const token = tokenParts[1];
  try {
    return { decoded: jwt.verify(token, JWT_SECRET) };
  } catch (_error) {
    return { error: { status: 401, body: { error: 'Invalid or expired token' } } };
  }
};

const resolveUserId = (decoded) => Number(decoded?.sub ?? decoded?.user_id ?? decoded?.id ?? 0);

export const createVerifyToken = ({ authContextStore }) => async (req, res, next) => {
  const signature = verifyBearerSignature(req);
  if (signature.error) {
    return res.status(signature.error.status).json(signature.error.body);
  }
  const decoded = signature.decoded;

  const userId = resolveUserId(decoded);
  const domain = String(decoded?.domain || '').trim().toLowerCase();
  const memberId = String(decoded?.member_id || '').trim();
  const contextKey = buildAuthContextKey({
    memberId,
    domain,
    userId
  });

  if (!contextKey) {
    return res.status(401).json({
      error: 'context_not_found',
      message: 'JWT does not contain sufficient context claims'
    });
  }

  try {
    const bitrixContext = await authContextStore.getContextByKey(contextKey);
    if (!bitrixContext) {
      return res.status(401).json({
        error: 'context_not_found',
        message: 'Bitrix context for current token is missing'
      });
    }

    req.user = {
      ...decoded,
      id: userId,
      user_id: userId
    };
    req.bitrixContext = {
      key: contextKey,
      ...bitrixContext
    };
    return next();
  } catch (error) {
    return res.status(500).json({
      error: 'auth_context_error',
      message: error.message
    });
  }
};

/**
 * S1 (ревью): /ping и /echo измеряют канал оператора, а не нашу БД —
 * см. diagRoutes.js. Но полный createVerifyToken всё равно делал
 * await authContextStore.getContextByKey(...) на каждый запрос, и с
 * дефолтным составным стором (databaseAuthContextStore) это поход в БД:
 * если БД зависает, зависают и оба зонда, и клиент читает это как «нет
 * связи», хотя сеть в порядке — ровно то, что эта фича должна диагностировать.
 *
 * Этот гвард отклоняет неверный/отсутствующий токен (та же verifyBearerSignature,
 * что и в createVerifyToken — крипто-логика не дублируется), но не строит
 * contextKey и не трогает authContextStore вовсе: у него физически нет
 * такой зависимости, ему неоткуда её взять. 1 МБ тело /echo остаётся за
 * этим гвардом — не аутентифицированный пользователь его не пройдёт.
 */
export const createVerifyTokenSignatureOnly = () => (req, res, next) => {
  const signature = verifyBearerSignature(req);
  if (signature.error) {
    return res.status(signature.error.status).json(signature.error.body);
  }
  const decoded = signature.decoded;
  const userId = resolveUserId(decoded);

  req.user = {
    ...decoded,
    id: userId,
    user_id: userId
  };
  return next();
};

export default createVerifyToken;

