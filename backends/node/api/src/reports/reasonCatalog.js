// Дефолтный seed — только для первичного заполнения экрана настроек.
// Бизнес-логика всегда читает reasons из настроек (settings.report.reasons[]).
export const DEFAULT_REASONS_SEED = Object.freeze([
  { code: 'fuel_truck', label: 'Приёмка топлива / бензовоз' },
  { code: 'delivery',   label: 'Приёмка товара' },
  { code: 'queue',      label: 'Очередь / много гостей' },
  { code: 'wc_busy',    label: 'Санузел занят' },
  { code: 'staff',      label: 'Нехватка персонала' },
  { code: 'other',      label: 'Другое (требует текст)' }
]);

const OTHER_CODE = 'other';
const OTHER_PREFIX = 'Другое: ';

/**
 * Создать каталог из массива причин (из настроек settings.report.reasons[]).
 * @param {Array<{code: string, label: string}>} reasons - из настроек, не хардкод
 */
export const createReasonCatalog = (reasons = []) => {
  const validReasons = Array.isArray(reasons)
    ? reasons.filter(r => r && typeof r.code === 'string' && r.code.trim())
    : [];

  const byCode = new Map(validReasons.map(r => [r.code, r.label]));
  const byLabel = new Map(validReasons.map(r => [r.label, r.code]));

  const isOther = (code) => String(code || '') === OTHER_CODE;

  const isValidCode = (code) => byCode.has(String(code || ''));

  const codeToLabel = (code) => byCode.get(String(code || ''));

  const labelToCode = (label) => byLabel.get(String(label || ''));

  /**
   * Кодировать значение для записи в CRM UF (строка).
   * Пресет → label; other + text → "Другое: <text>"
   */
  const encodeValue = (code, text) => {
    if (isOther(code)) {
      return `${OTHER_PREFIX}${String(text || '').trim()}`;
    }
    return codeToLabel(code) || String(code);
  };

  /**
   * Декодировать значение из CRM UF обратно в { code, text }.
   * "Другое: ..." → { code: 'other', text }
   * label из каталога → { code, text: null }
   * нераспознанное → { code: 'other', text: original }
   */
  const decodeValue = (value) => {
    const str = String(value || '').trim();
    if (str.startsWith(OTHER_PREFIX)) {
      return { code: OTHER_CODE, text: str.slice(OTHER_PREFIX.length).trim() || null };
    }
    const code = labelToCode(str);
    if (code) return { code, text: null };
    // нераспознанное — сохранить как other + полный текст
    return { code: OTHER_CODE, text: str || null };
  };

  return { isOther, isValidCode, codeToLabel, labelToCode, encodeValue, decodeValue, reasons: validReasons };
};

export default createReasonCatalog;
