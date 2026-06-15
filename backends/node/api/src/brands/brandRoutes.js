/**
 * brandRoutes.js — REST-роутер для управления брендами.
 *
 * Маршруты (монтируются в server.js под /api/brands с verifyToken + attachAccessContext):
 *   GET    /                    — список брендов
 *   POST   /                    — создать бренд {name}
 *   PUT    /:id                 — обновить бренд {name}
 *   DELETE /:id                 — удалить бренд
 *   PUT    /:id/azs             — установить состав АЗС (setBrandAzs, с переносом)
 *   POST   /:id/external-link   — получить/обновить внешнюю ссылку на папку Диска
 *
 * Гейт: capabilities.settings (admin). BUG-A8: disk-вызовы — под admin-OAuth (getAdminContext).
 */

import express from 'express';

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const isAdmin = (req) => Boolean(req.accessContext?.capabilities?.settings);

const requireAdmin = (req, res) => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createBrandRouter = ({
  brandStore,
  bitrixClient,
  getAdminContext,
  diskRootFolderId = 0
} = {}) => {
  if (!brandStore) throw new Error('brandStore is required');
  if (!bitrixClient) throw new Error('bitrixClient is required');
  if (typeof getAdminContext !== 'function') throw new Error('getAdminContext is required');

  const router = express.Router();

  // ── GET / — список брендов ────────────────────────────────────────────────

  router.get('/', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const brands = await brandStore.listBrands();
      return res.json({ brands });
    } catch (error) {
      console.error('[brandRoutes] GET / error', error);
      return res.status(500).json({ error: 'brands_list_failed', message: error.message });
    }
  });

  // ── POST / — создать бренд ────────────────────────────────────────────────

  router.post('/', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'invalid_payload', message: 'name is required' });
    }
    try {
      const brand = await brandStore.createBrand({ name });
      return res.status(201).json({ brand });
    } catch (error) {
      console.error('[brandRoutes] POST / error', error);
      return res.status(500).json({ error: 'brand_create_failed', message: error.message });
    }
  });

  // ── PUT /:id — обновить бренд ─────────────────────────────────────────────

  router.put('/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'invalid_payload', message: 'name is required' });
    }
    try {
      const brand = await brandStore.getBrand(id);
      if (!brand) return res.status(404).json({ error: 'brand_not_found', message: `Brand ${id} not found` });
      const updated = await brandStore.updateBrand(id, { name });
      return res.json({ brand: updated });
    } catch (error) {
      console.error('[brandRoutes] PUT /:id error', error);
      return res.status(500).json({ error: 'brand_update_failed', message: error.message });
    }
  });

  // ── DELETE /:id — удалить бренд ───────────────────────────────────────────

  router.delete('/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    try {
      const brand = await brandStore.getBrand(id);
      if (!brand) return res.status(404).json({ error: 'brand_not_found', message: `Brand ${id} not found` });
      await brandStore.deleteBrand(id);
      return res.json({ ok: true });
    } catch (error) {
      console.error('[brandRoutes] DELETE /:id error', error);
      return res.status(500).json({ error: 'brand_delete_failed', message: error.message });
    }
  });

  // ── PUT /:id/azs — установить состав АЗС ─────────────────────────────────
  // Инвариант «одна АЗС = один бренд» обеспечивается в сторе через ON CONFLICT DO UPDATE.
  // Здесь 200 + перенос (а не 409), т.к. стор реализует «перенос», а не ошибку дубликата.

  router.put('/:id/azs', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const rawIds = req.body?.azsIds;
    const azsIds = Array.isArray(rawIds) ? rawIds.map(String).filter(Boolean) : [];
    try {
      const brand = await brandStore.getBrand(id);
      if (!brand) return res.status(404).json({ error: 'brand_not_found', message: `Brand ${id} not found` });
      await brandStore.setBrandAzs(id, azsIds);
      const currentAzsIds = await brandStore.listAzsForBrand(id);
      return res.json({ brandId: id, azsIds: currentAzsIds });
    } catch (error) {
      console.error('[brandRoutes] PUT /:id/azs error', error);
      return res.status(500).json({ error: 'brand_set_azs_failed', message: error.message });
    }
  });

  // ── POST /:id/external-link — получить/обновить внешнюю ссылку ───────────
  //
  // Алгоритм:
  //   1. Получить бренд из БД.
  //   2. Если нет папки Диска (disk_folder_id = null):
  //      a. Создать папку через diskApi.createFolder(diskRootFolderId, brandName, adminCtx)
  //      b. Сохранить setBrandDiskFolder(brandId, folderId, brandName)
  //   3. Вызвать diskApi.getExternalLink(folderId, adminCtx)
  //   4. Сохранить setBrandExternalLink(brandId, link)
  //   5. Вернуть { link }
  //
  // Контекст: admin-OAuth (BUG-A8 — app.option/disk требует контекст приложения)

  router.post('/:id/external-link', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    try {
      const brand = await brandStore.getBrand(id);
      if (!brand) return res.status(404).json({ error: 'brand_not_found', message: `Brand ${id} not found` });

      // BUG-A8: диск под admin-OAuth контекстом, НЕ вебхук
      const adminCtx = await getAdminContext();
      const diskApi = bitrixClient.diskApi;

      let folderId = brand.disk_folder_id ? Number(brand.disk_folder_id) : 0;

      // Шаг 2: создать папку если нет
      if (!folderId) {
        const folderName = String(brand.name || `brand_${id}`).trim();
        const rootId = Number(diskRootFolderId) || 0;
        const created = await diskApi.createFolder(rootId, folderName, adminCtx);
        folderId = Number(created.id);
        await brandStore.setBrandDiskFolder(id, folderId, folderName);
      }

      // Шаг 3: получить ссылку
      const link = await diskApi.getExternalLink(folderId, adminCtx);

      // Шаг 4: сохранить ссылку
      await brandStore.setBrandExternalLink(id, link);

      return res.json({ link });
    } catch (error) {
      console.error('[brandRoutes] POST /:id/external-link error', error);
      return res.status(502).json({ error: 'external_link_failed', message: error.message });
    }
  });

  return router;
};

export default createBrandRouter;
