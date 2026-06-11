/**
 * photoRemarkService — sends photo remarks via Bitrix24 bot and writes to the journal.
 *
 * createPhotoRemarkService({ bitrixClient, remarkStore, reportsStore, settingsStore,
 *                             getAdminContext, mode, botId })
 *   → { sendRemark({ azsId, azsTitle, recipientRole, message, photos, sender }) }
 *
 * PHOTO_FORWARD_MODE:
 *   'bot'    (default) — imbot.v2.File.upload per file; text on first file only
 *   'commit'           — im.disk.file.commit with all FILE_ID[] under admin context
 *
 * photos: Array<{ reportId: number, photoCode: string }>
 * sender: { id: number, name: string | null }
 *
 * Returns the journal record (from remarkStore).
 * Always writes a journal record — 'failed' on error, 'sent' on success.
 */

import { resolveAzsRecipients } from '../reports/azsRecipients.js';
import { RECIPIENT_NOT_SET } from '../reports/errorCodes.js';

const resolveMode = (envValue) => {
  const v = String(envValue || '').trim().toLowerCase();
  return v === 'commit' ? 'commit' : 'bot';
};

const buildRemarkText = ({ azsTitle, senderName, message }) => {
  const label = String(azsTitle || '').trim() || '';
  const from = String(senderName || '').trim();
  const text = String(message || '').trim();
  const prefix = label ? `Замечание по АЗС ${label}` : 'Замечание';
  const suffix = from ? ` (${from})` : '';
  return `${prefix}${suffix}: ${text}`;
};

export const createPhotoRemarkService = ({
  bitrixClient,
  remarkStore,
  reportsStore,
  settingsStore,
  getAdminContext,
  mode: modeOverride = null,
  botId: botIdOverride = null
}) => {
  if (!bitrixClient) throw new Error('bitrixClient is required');
  if (!remarkStore) throw new Error('remarkStore is required');
  if (!reportsStore) throw new Error('reportsStore is required');
  if (!settingsStore) throw new Error('settingsStore is required');

  const resolveAdminContext = async (fallback = {}) => {
    if (typeof getAdminContext === 'function') {
      try {
        const ctx = await getAdminContext();
        if (ctx) return ctx;
      } catch {
        // best-effort
      }
    }
    return fallback;
  };

  /**
   * deliverRemark — pure delivery without DB writes.
   * Sends photos to recipient via bot or commit mode.
   *
   * @param {object} p
   * @param {Array<{reportId:number, photoCode:string}>} p.photos
   * @param {{id:number|string, name:string|null}} p.recipient
   * @param {string} p.remarkText
   * @param {object} p.adminContext
   * @returns {Promise<void>}
   */
  const deliverRemark = async ({ photos, recipient, remarkText, adminContext }) => {
    const mode = resolveMode(modeOverride ?? process.env.PHOTO_FORWARD_MODE);
    const botId = Number(botIdOverride ?? process.env.BITRIX_BOT_ID ?? 0);

    if (mode === 'commit') {
      // ------------------------------------------------------------------
      // commit mode: im.disk.file.commit with all disk_object_ids
      // ------------------------------------------------------------------
      const fileIds = [];
      for (const { reportId, photoCode } of photos) {
        const photo = await reportsStore.getPhoto(reportId, photoCode);
        if (photo?.diskObjectId) {
          fileIds.push(photo.diskObjectId);
        }
      }

      await bitrixClient.callMethod('im.disk.file.commit', {
        DIALOG_ID: String(recipient.id),
        FILE_ID: fileIds,
        MESSAGE: remarkText
      }, adminContext);
    } else {
      // ------------------------------------------------------------------
      // bot mode: imbot.v2.File.upload per file
      // fields.name, fields.content, fields.message are DIRECT children of fields
      // ------------------------------------------------------------------
      if (!botId) {
        throw new Error('BITRIX_BOT_ID is required for PHOTO_FORWARD_MODE=bot');
      }

      let isFirst = true;
      let sentCount = 0;
      const total = photos.length;
      for (const { reportId, photoCode } of photos) {
        const photo = await reportsStore.getPhoto(reportId, photoCode);
        if (!photo?.diskObjectId) continue;

        const fallbackName = `photo_${reportId}_${photoCode}.jpg`;
        const { base64, name } = await bitrixClient.diskApi.downloadFileContent(
          photo.diskObjectId,
          adminContext
        );

        const fields = { name: photo.fileName || name || fallbackName, content: base64 };
        if (isFirst) {
          fields.message = remarkText;
          isFirst = false;
        }

        try {
          await bitrixClient.callMethod('imbot.v2.File.upload', {
            botId: Number(botId),
            dialogId: String(recipient.id),
            fields
          }, adminContext);
          sentCount++;
        } catch (err) {
          throw Object.assign(
            new Error(`sent ${sentCount}/${total}: ${err.message}`),
            { cause: err }
          );
        }
      }
    }
  };

  /**
   * sendRemark — main entry point.
   *
   * @param {object} params
   * @param {string}  params.azsId
   * @param {string}  [params.azsTitle]
   * @param {'manager'|'admin'} params.recipientRole
   * @param {string}  params.message
   * @param {Array<{reportId:number, photoCode:string}>} params.photos  max 20
   * @param {{id:number, name:string|null}} params.sender
   * @returns {Promise<object>} — journal record
   */
  const sendRemark = async ({
    azsId,
    azsTitle = null,
    recipientRole,
    message,
    photos = [],
    sender = {}
  }) => {
    // -----------------------------------------------------------------------
    // 1. Resolve recipient
    // -----------------------------------------------------------------------
    const settings = await settingsStore.read();
    const adminContext = await resolveAdminContext();

    const { manager, admin } = await resolveAzsRecipients({
      azsId,
      settings,
      bitrixClient,
      context: adminContext
    });

    const recipient = recipientRole === 'manager' ? manager : admin;
    if (!recipient || !recipient.id) {
      const err = new Error(`Recipient role "${recipientRole}" is not configured for AZS ${azsId}`);
      err.errorCode = RECIPIENT_NOT_SET;
      throw err;
    }

    const remarkText = buildRemarkText({ azsTitle, senderName: sender?.name, message });

    // -----------------------------------------------------------------------
    // 2. Insert journal record (initial status 'sent', will be overwritten on failure)
    // -----------------------------------------------------------------------
    const record = await remarkStore.insertRemark({
      azsId,
      azsTitle: azsTitle ?? null,
      recipientRole,
      recipientUserId: recipient.id,
      recipientName: recipient.name ?? null,
      message,
      senderUserId: sender?.id ?? null,
      senderName: sender?.name ?? null,
      photos
    });

    // -----------------------------------------------------------------------
    // 3. Deliver
    // -----------------------------------------------------------------------
    try {
      await deliverRemark({ photos, recipient, remarkText, adminContext });

      // success — update record delivery status
      await remarkStore.markDelivery(record.id, 'sent', null);
      return { ...record, deliveryStatus: 'sent', deliveryError: null };
    } catch (err) {
      const errorText = String(err?.message || err || 'unknown error').slice(0, 1000);
      await remarkStore.markDelivery(record.id, 'failed', errorText);
      return { ...record, deliveryStatus: 'failed', deliveryError: errorText };
    }
  };

  /**
   * retryRemark — retry delivery for an existing journal record.
   * Uses recipient from the stored record; does NOT create a new journal entry.
   *
   * @param {object} record — existing journal record (from remarkStore.getById)
   * @returns {Promise<object>} — updated journal record
   */
  const retryRemark = async (record) => {
    const adminContext = await resolveAdminContext();
    const recipient = { id: record.recipientUserId, name: record.recipientName };
    const remarkText = buildRemarkText({
      azsTitle: record.azsTitle,
      senderName: record.senderName,
      message: record.message
    });
    const photos = record.photos || [];

    try {
      await deliverRemark({ photos, recipient, remarkText, adminContext });
      await remarkStore.markDelivery(record.id, 'sent', null);
      return { ...record, deliveryStatus: 'sent', deliveryError: null };
    } catch (err) {
      const errorText = String(err?.message || err || 'unknown error').slice(0, 1000);
      await remarkStore.markDelivery(record.id, 'failed', errorText);
      return { ...record, deliveryStatus: 'failed', deliveryError: errorText };
    }
  };

  return { sendRemark, retryRemark, deliverRemark };
};

export default createPhotoRemarkService;
