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
 *
 * S8-B2a: корень папки бренда резолвится через ensureRootFolder (тот же механизм,
 * что photo-upload) на основе settings.disk.rootFolderId + BITRIX_DISK_STORAGE_ROOT_ID.
 * Имя папки санитизируется через sanitizeSegment перед созданием.
 */

import express from 'express';
import {
  ensureRootFolder as defaultEnsureRootFolder,
  sanitizeSegment
} from '../disk/diskService.js';

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
  settingsStore = null,
  ensureRootFolder = defaultEnsureRootFolder
} = {}) => {
  if (!brandStore) throw new Error('brandStore is required');
  if (!bitrixClient) throw new Error('bitrixClient is required');
  if (typeof getAdminContext !== 'function') throw new Error('getAdminContext is required');

  const router = express.Router();

  // Сериализация brand-row (snake_case из БД, без azsIds) → DTO фронта
  // (camelCase + azsIds). Frontend (stores/api.ts тип BrandItem, brands.client.vue)
  // ожидает именно этот формат и обёртки { items } / { item }. Без выравнивания
  // бренды не грузятся, а создание падает с
  // "Cannot read properties of undefined (reading 'id')".
  const serializeBrand = async (brand) => {
    if (!brand) return null;
    const azsIds = await brandStore.listAzsForBrand(brand.id);
    return {
      id: brand.id,
      name: brand.name,
      diskFolderId: brand.disk_folder_id ?? null,
      diskFolderPath: brand.disk_folder_path ?? null,
      externalLink: brand.external_link ?? null,
      externalLinkUpdatedAt: brand.external_link_updated_at ?? null,
      azsIds,
      createdAt: brand.created_at ?? null,
      updatedAt: brand.updated_at ?? null
    };
  };

  // ── GET / — список брендов ────────────────────────────────────────────────

  router.get('/', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const brands = await brandStore.listBrands();
      const items = await Promise.all(brands.map((b) => serializeBrand(b)));
      return res.json({ items });
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
      return res.status(201).json({ item: await serializeBrand(brand) });
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
      return res.json({ item: await serializeBrand(updated) });
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
      const updated = await brandStore.getBrand(id);
      return res.json({ item: await serializeBrand(updated) });
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
  //      a. Резолвить корневую папку через ensureRootFolder (settings.disk.rootFolderId /
  //         BITRIX_DISK_STORAGE_ROOT_ID) — тот же механизм, что photo-upload (S8-B2a).
  //      b. Создать папку через diskApi.createFolder(rootId, sanitizedName, adminCtx)
  //      c. Сохранить setBrandDiskFolder(brandId, folderId, sanitizedName)
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
        // S8-B2a: корень резолвится через ensureRootFolder (как photo-upload),
        // а не через env DISK_ROOT_FOLDER_ID.
        const settings = settingsStore ? await settingsStore.read({ context: adminCtx }) : {};
        const rootId = await ensureRootFolder(
          diskApi,
          {
            configuredRootFolderId: Number(settings.disk?.rootFolderId || 0),
            storageRootId: Number(process.env.BITRIX_DISK_STORAGE_ROOT_ID || 1),
            appFolderName: process.env.BITRIX_DISK_APP_FOLDER || 'AZS-Photo-Reports'
          },
          adminCtx
        );
        // S8-B2a ISSUE-3: санитизируем имя перед созданием папки
        const folderName = sanitizeSegment(String(brand.name || `brand_${id}`).trim(), `brand_${id}`);
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
