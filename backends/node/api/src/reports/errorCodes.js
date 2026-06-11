/**
 * Typed error codes for known user-facing report errors.
 *
 * These constants are the authoritative source for the front-end error-message
 * dictionary (next sprint wave). Every code here maps to a human-readable
 * message on the client side.
 *
 * Response shape when a typed code is present:
 *   { error: <legacy message string — backward-compat>, errorCode: '<CODE>', meta?: {...} }
 *
 * Backward compatibility: the `error` field continues to carry the snake_case
 * technical code (as before); `errorCode` is an ADDITIONAL field with the
 * typed constant. Front-ends that already read `error` are unaffected.
 */

/**
 * AZS_PHOTO_SET_EMPTY
 * The AZS smart-process item exists but its "required photo set" UF field is
 * empty or contains no valid IDs. The operator cannot start a photo report
 * until the AZS card is filled in.
 * meta: { azsId: string }
 */
export const AZS_PHOTO_SET_EMPTY = 'AZS_PHOTO_SET_EMPTY';

/**
 * AZS_CARD_NOT_FOUND
 * The AZS smart-process item referenced by the report does not exist in
 * Bitrix24 (getCrmItem returned null / 404).
 * meta: { azsId: string }
 */
export const AZS_CARD_NOT_FOUND = 'AZS_CARD_NOT_FOUND';

/**
 * PHOTO_TYPE_NOT_FOUND
 * All photo-type CRM items referenced in the AZS photoSet field returned null
 * from Bitrix24. The photo-type smart process may have been deleted or
 * misconfigured.
 * meta: { azsId: string }
 */
export const PHOTO_TYPE_NOT_FOUND = 'PHOTO_TYPE_NOT_FOUND';

/**
 * REPORT_NOT_FOUND
 * The report record with the given id does not exist in the local database.
 * meta: { reportId: number }
 */
export const REPORT_NOT_FOUND = 'REPORT_NOT_FOUND';

/**
 * RECIPIENT_NOT_SET
 * The requested recipient role (manager or admin) is not configured for this AZS.
 * meta: { azsId: string, recipientRole: string }
 */
export const RECIPIENT_NOT_SET = 'RECIPIENT_NOT_SET';

/**
 * REMARK_NOT_FOUND
 * The photo_remark record with the given id does not exist.
 * meta: { remarkId: number }
 */
export const REMARK_NOT_FOUND = 'REMARK_NOT_FOUND';

/**
 * PHOTO_CODE_NOT_REQUIRED
 * The uploaded photo code is not in the required photo set for this AZS.
 * meta: { azsId: string, photoCode: string }
 */
export const PHOTO_CODE_NOT_REQUIRED = 'PHOTO_CODE_NOT_REQUIRED';

/**
 * PHOTO_EXIF_TOO_OLD
 * The photo EXIF date is older than the allowed maximum age.
 * meta: { ageMinutes: number }
 */
export const PHOTO_EXIF_TOO_OLD = 'PHOTO_EXIF_TOO_OLD';

/**
 * REPORT_PHOTOS_MISSING
 * The report cannot be submitted because required photos are missing.
 * meta: { missingCodes: string[] }
 */
export const REPORT_PHOTOS_MISSING = 'REPORT_PHOTOS_MISSING';

/**
 * PHOTOS_AZS_MISMATCH
 * One or more photos in the remark request belong to a different AZS than the
 * one declared in azsId. Each photo's report must belong to the same AZS as
 * the remark being sent.
 * meta: { azsId: string, photoReportId: number, photoCode: string, actualAzsId: string }
 */
export const PHOTOS_AZS_MISMATCH = 'PHOTOS_AZS_MISMATCH';

/**
 * BOT_UNAVAILABLE
 * The manual dispatch was rejected because no active Bitrix24 auth context is
 * available — the administrator session has expired and no webhook fallback is
 * configured. The request is aborted WITHOUT creating a slot (so it cannot hang
 * in 'reserved' status forever).
 *
 * What the user sees (useErrorText):
 *   'Рассылка сейчас недоступна: нет связи с Битрикс24. Попробуйте позже или
 *    переоткройте приложение.'
 *
 * HTTP status: 503 Service Unavailable.
 */
export const BOT_UNAVAILABLE = 'BOT_UNAVAILABLE';
