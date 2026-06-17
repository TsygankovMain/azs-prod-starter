/**
 * usersRoutes.js — Express router for portal user search (FEED-2 BE-2).
 *
 * Routes (mounted in server.js under /api/users with verifyToken + attachAccessContext):
 *   GET /search?q=<string>  — поиск сотрудников портала через Bitrix user.search
 *                             под admin-OAuth контекстом.
 *
 * Response: { items: [{ id: number, name: string, position: string|null }] }
 *
 * Guard: capabilities.reviewer || capabilities.settings (проверяющий/admin).
 * Деградация: пустой q, короткий q (<2 символа), ошибка Bitrix → { items: [] }.
 *
 * Factory:
 *   createUsersRouter({ bitrixClient, getAdminContext })
 */

import express from 'express';

// ---------------------------------------------------------------------------
// Guard — same pattern as photoFeedRoutes / photoRemarkRoutes
// ---------------------------------------------------------------------------

const canReview = (req) => (
  Boolean(req.accessContext?.capabilities?.reviewer) ||
  Boolean(req.accessContext?.capabilities?.settings)
);

// ---------------------------------------------------------------------------
// Map a single Bitrix user object → { id, name, position }
// ---------------------------------------------------------------------------

const mapUser = (user) => {
  const id = Number(user?.ID ?? user?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) return null;

  const firstName = String(user?.NAME || '').trim();
  const lastName = String(user?.LAST_NAME || '').trim();
  const login = String(user?.LOGIN || '').trim();
  const name = [firstName, lastName].filter(Boolean).join(' ') || login || String(id);

  const workPosition = String(user?.WORK_POSITION || '').trim();
  const position = workPosition || null;

  return { id, name, position };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createUsersRouter = ({
  bitrixClient,
  getAdminContext
} = {}) => {
  if (!bitrixClient) throw new Error('bitrixClient is required');

  const router = express.Router();

  const resolveAdminCtx = async (fallback = {}) => {
    if (typeof getAdminContext === 'function') {
      try {
        const ctx = await getAdminContext();
        // FEED-USERS: admin-контекст годен ТОЛЬКО если несёт авторизацию. Пустой {}
        // (admin протух — BUG-022) непригоден: вернуть его → user.search уходит без
        // auth → пустой список. Тогда используем OAuth-контекст запроса — проверяющий
        // открыл приложение и имеет права на user.search.
        if (ctx && (String(ctx.authId || '').trim() || ctx.isWebhook)) {
          return ctx;
        }
      } catch {
        // best-effort — fall back to request context
      }
    }
    return fallback;
  };

  // -------------------------------------------------------------------------
  // GET /search?q=<string>
  //
  // Поиск сотрудников портала Bitrix24 под admin-OAuth контекстом.
  // Пустой q или q < 2 символа → { items: [] } без вызова Bitrix.
  // Ошибка Bitrix → { items: [] } + warn-лог (деградация).
  // -------------------------------------------------------------------------
  router.get('/search', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const q = String(req.query?.q || '').trim();

    // Short-circuit: query too short — no Bitrix call needed
    if (q.length < 2) {
      return res.json({ items: [] });
    }

    try {
      const context = await resolveAdminCtx(req.bitrixContext || {});

      const result = await bitrixClient.callMethod(
        'user.search',
        // Б24: FIND нельзя сочетать с другими полями фильтра («FIND cannot be used
        // with any other field») — отправляем ОДИН FIND. Активных отфильтруем ниже
        // по полю ACTIVE из ответа (FEED-USERS).
        { FIND: q },
        context
      );

      const rows = Array.isArray(result) ? result
        : Array.isArray(result?.result) ? result.result
        : [];

      const items = rows
        .filter((u) => String(u?.ACTIVE || '').toUpperCase() === 'Y')
        .map(mapUser)
        .filter(Boolean)
        .slice(0, 20);

      return res.json({ items });
    } catch (err) {
      console.warn('[users/search] Bitrix call failed (degraded to empty list):', err.message);
      return res.json({ items: [] });
    }
  });

  return router;
};

export default createUsersRouter;
