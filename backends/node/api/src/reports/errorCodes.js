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
