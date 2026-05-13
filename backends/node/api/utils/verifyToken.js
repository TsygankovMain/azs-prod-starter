import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { buildAuthContextKey } from '../src/auth/authContextStore.js';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

export const createVerifyToken = ({ authContextStore }) => async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const tokenParts = authHeader.split(' ');
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  const token = tokenParts[1];
  let decoded = null;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (_error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const userId = Number(decoded?.sub ?? decoded?.user_id ?? decoded?.id ?? 0);
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

export default createVerifyToken;

