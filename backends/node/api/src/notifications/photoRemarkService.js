/**
 * photoRemarkService — sends photo remarks via Bitrix24 bot and writes to the journal.
 *
 * UX-2: Per-photo comments. Each photo in the batch gets its OWN bot message
 * with its own comment text and that single file attached. Per-photo delivery
 * status is tracked independently. retryPhoto re-sends a single photo.
 *
 * createPhotoRemarkService({ bitrixClient, remarkStore, reportsStore, settingsStore,
 *                             getAdminContext, mode, botId })
 *   → { sendRemark({ azsId, azsTitle, recipientRole,
 *                    photos:[{reportId,photoCode,comment}], sender }) }
 *
 * PHOTO_FORWARD_MODE:
 *   'bot'    (default) — imbot.v2.File.upload per file; each with its own comment
 *   'commit'           — im.disk.file.commit with all FILE_ID[] + combined message
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

/**
 * Build per-photo remark text: includes AZS label, sender, and THAT photo's comment.
 */
const buildPhotoText = ({ azsTitle, senderName, comment }) => {
  const label = String(azsTitle || '').trim() || '';
  const from = String(senderName || '').trim();
  const text = String(comment || '').trim();
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
   * sendSinglePhotoMessage — sends ONE photo with its OWN comment as a bot message.
   * Returns { status: 'sent'|'failed', error: string|null }
   *
   * @param {object} p
   * @param {{reportId:number, photoCode:string, comment:string}} p.photo
   * @param {{id:number|string, name:string|null}} p.recipient
   * @param {string} p.messageText — pre-built text for this photo
   * @param {object} p.adminContext
   * @returns {Promise<{status:string, error:string|null}>}
   */
  const sendSinglePhotoMessage = async ({ photo, recipient, messageText, adminContext }) => {
    const mode = resolveMode(modeOverride ?? process.env.PHOTO_FORWARD_MODE);
    const botId = Number(botIdOverride ?? process.env.BITRIX_BOT_ID ?? 0);

    if (mode === 'commit') {
      // In commit mode: attach single file with its comment
      const photoRow = await reportsStore.getPhoto(photo.reportId, photo.photoCode);
      if (!photoRow?.diskObjectId) {
        return { status: 'failed', error: `No disk object for ${photo.photoCode}` };
      }
      await bitrixClient.callMethod('im.disk.file.commit', {
        DIALOG_ID: String(recipient.id),
        FILE_ID: [photoRow.diskObjectId],
        MESSAGE: messageText
      }, adminContext);
      return { status: 'sent', error: null };
    }

    // bot mode: imbot.v2.File.upload per file with message
    if (!botId) {
      throw new Error('BITRIX_BOT_ID is required for PHOTO_FORWARD_MODE=bot');
    }

    const photoRow = await reportsStore.getPhoto(photo.reportId, photo.photoCode);
    if (!photoRow?.diskObjectId) {
      return { status: 'failed', error: `No disk object for ${photo.photoCode}` };
    }

    const fallbackName = `photo_${photo.reportId}_${photo.photoCode}.jpg`;
    const { base64, name } = await bitrixClient.diskApi.downloadFileContent(
      photoRow.diskObjectId,
      adminContext
    );

    await bitrixClient.callMethod('imbot.v2.File.upload', {
      botId: Number(botId),
      dialogId: String(recipient.id),
      fields: {
        name: photoRow.fileName || name || fallbackName,
        content: base64,
        message: messageText
      }
    }, adminContext);

    return { status: 'sent', error: null };
  };

  /**
   * deliverRemark — loops photos and sends ONE message per photo (UX-2).
   * Writes per-photo delivery_status after each send.
   * Returns overall status: 'sent' if ALL photos succeeded, 'failed' otherwise.
   *
   * For commit mode: single batch call with combined message (fallback, no per-photo comment).
   *
   * @param {object} p
   * @param {number} p.remarkId
   * @param {Array<{reportId:number, photoCode:string, comment:string}>} p.photos
   * @param {{id:number|string, name:string|null}} p.recipient
   * @param {string} p.azsTitle
   * @param {string} p.senderName
   * @param {object} p.adminContext
   * @returns {Promise<{status:'sent'|'failed', error:string|null}>}
   */
  const deliverRemark = async ({ remarkId, photos, recipient, azsTitle, senderName, adminContext }) => {
    const mode = resolveMode(modeOverride ?? process.env.PHOTO_FORWARD_MODE);

    if (mode === 'commit') {
      // commit mode: one call with all file IDs and a combined message
      const fileIds = [];
      const commentParts = [];
      // Track which photos are included vs dropped (no diskObjectId)
      const includedPhotos = [];
      const droppedPhotos = [];
      for (const ph of photos) {
        const photoRow = await reportsStore.getPhoto(ph.reportId, ph.photoCode);
        if (photoRow?.diskObjectId) {
          fileIds.push(photoRow.diskObjectId);
          const text = String(ph.comment || '').trim();
          if (text) commentParts.push(`${ph.photoCode}: ${text}`);
          includedPhotos.push(ph);
        } else {
          droppedPhotos.push(ph);
        }
      }

      // Mark dropped photos as failed immediately — they were NOT sent
      for (const ph of droppedPhotos) {
        await remarkStore.markPhotoDelivery(
          remarkId, ph.reportId, ph.photoCode,
          'failed', `No disk object for ${ph.photoCode}`
        );
      }

      const combinedText = buildPhotoText({
        azsTitle,
        senderName,
        comment: commentParts.join('; ') || '—'
      });
      try {
        await bitrixClient.callMethod('im.disk.file.commit', {
          DIALOG_ID: String(recipient.id),
          FILE_ID: fileIds,
          MESSAGE: combinedText
        }, adminContext);
        // Mark only the actually-included photos as sent
        for (const ph of includedPhotos) {
          await remarkStore.markPhotoDelivery(remarkId, ph.reportId, ph.photoCode, 'sent', null);
        }
        // Overall status: failed if any photos were dropped
        if (droppedPhotos.length > 0) {
          const dropError = `No disk object for ${droppedPhotos.map((p) => p.photoCode).join(', ')}`;
          return { status: 'failed', error: dropError };
        }
        return { status: 'sent', error: null };
      } catch (err) {
        const errorText = String(err?.message || err || 'unknown error').slice(0, 1000);
        for (const ph of includedPhotos) {
          await remarkStore.markPhotoDelivery(remarkId, ph.reportId, ph.photoCode, 'failed', errorText);
        }
        return { status: 'failed', error: errorText };
      }
    }

    // bot mode: one message per photo
    let allSent = true;
    let firstError = null;

    for (const ph of photos) {
      const messageText = buildPhotoText({ azsTitle, senderName, comment: ph.comment });
      let photoStatus = 'sent';
      let photoError = null;

      try {
        const result = await sendSinglePhotoMessage({
          photo: ph,
          recipient,
          messageText,
          adminContext
        });
        photoStatus = result.status;
        photoError = result.error;
      } catch (err) {
        photoStatus = 'failed';
        photoError = String(err?.message || err || 'unknown error').slice(0, 1000);
      }

      await remarkStore.markPhotoDelivery(remarkId, ph.reportId, ph.photoCode, photoStatus, photoError);

      if (photoStatus !== 'sent') {
        allSent = false;
        if (!firstError) firstError = photoError;
      }
    }

    return allSent
      ? { status: 'sent', error: null }
      : { status: 'failed', error: firstError };
  };

  /**
   * sendRemark — main entry point.
   *
   * @param {object} params
   * @param {string}  params.azsId
   * @param {string}  [params.azsTitle]
   * @param {'manager'|'admin'} params.recipientRole
   * @param {Array<{reportId:number, photoCode:string, comment:string}>} params.photos  1..20
   * @param {{id:number, name:string|null}} params.sender
   * @returns {Promise<object>} — journal record
   */
  const sendRemark = async ({
    azsId,
    azsTitle = null,
    recipientRole,
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

    // -----------------------------------------------------------------------
    // 2. Insert journal record (initial status 'sent', overwritten on failure)
    // -----------------------------------------------------------------------
    const record = await remarkStore.insertRemark({
      azsId,
      azsTitle: azsTitle ?? null,
      recipientRole,
      recipientUserId: recipient.id,
      recipientName: recipient.name ?? null,
      senderUserId: sender?.id ?? null,
      senderName: sender?.name ?? null,
      photos  // includes per-photo comment
    });

    // -----------------------------------------------------------------------
    // 3. Deliver: one message per photo, write per-photo status
    // -----------------------------------------------------------------------
    const { status, error } = await deliverRemark({
      remarkId: record.id,
      photos,
      recipient,
      azsTitle: azsTitle ?? null,
      senderName: sender?.name ?? null,
      adminContext
    });

    // Update batch-level status
    await remarkStore.markDelivery(record.id, status, error);
    return { ...record, deliveryStatus: status, deliveryError: error };
  };

  /**
   * retryRemark — retry delivery for an ENTIRE existing journal record.
   * Uses recipient from the stored record; does NOT create a new journal entry.
   *
   * @param {object} record — existing journal record (from remarkStore.getById)
   * @returns {Promise<object>} — updated journal record
   */
  const retryRemark = async (record) => {
    const adminContext = await resolveAdminContext();
    const recipient = { id: record.recipientUserId, name: record.recipientName };
    const photos = record.photos || [];

    const { status, error } = await deliverRemark({
      remarkId: record.id,
      photos,
      recipient,
      azsTitle: record.azsTitle,
      senderName: record.senderName,
      adminContext
    });

    await remarkStore.markDelivery(record.id, status, error);
    return { ...record, deliveryStatus: status, deliveryError: error };
  };

  /**
   * retryPhoto — retry delivery for a SINGLE photo of an existing remark.
   * Does NOT create a new journal entry; updates per-photo delivery_status.
   *
   * @param {number} remarkId
   * @param {number} reportId
   * @param {string} photoCode
   * @returns {Promise<{remarkId, reportId, photoCode, deliveryStatus, deliveryError}>}
   */
  const retryPhoto = async (remarkId, reportId, photoCode) => {
    const adminContext = await resolveAdminContext();

    // Load the full remark to get recipient + azsTitle + senderName + photo comment
    const record = await remarkStore.getById(remarkId);
    if (!record) {
      const err = new Error(`Remark ${remarkId} not found`);
      err.errorCode = 'REMARK_NOT_FOUND';
      throw err;
    }

    const photo = (record.photos || []).find(
      (p) => Number(p.reportId) === Number(reportId) && p.photoCode === photoCode
    );
    if (!photo) {
      const err = new Error(`Photo ${photoCode} of report ${reportId} not found in remark ${remarkId}`);
      err.errorCode = 'PHOTO_NOT_FOUND';
      throw err;
    }

    const recipient = { id: record.recipientUserId, name: record.recipientName };
    const messageText = buildPhotoText({
      azsTitle: record.azsTitle,
      senderName: record.senderName,
      comment: photo.comment
    });

    let photoStatus = 'sent';
    let photoError = null;

    try {
      const result = await sendSinglePhotoMessage({
        photo,
        recipient,
        messageText,
        adminContext
      });
      photoStatus = result.status;
      photoError = result.error;
    } catch (err) {
      photoStatus = 'failed';
      photoError = String(err?.message || err || 'unknown error').slice(0, 1000);
    }

    await remarkStore.markPhotoDelivery(remarkId, reportId, photoCode, photoStatus, photoError);

    return {
      remarkId,
      reportId: Number(reportId),
      photoCode,
      deliveryStatus: photoStatus,
      deliveryError: photoError
    };
  };

  return { sendRemark, retryRemark, retryPhoto, deliverRemark };
};

export default createPhotoRemarkService;
