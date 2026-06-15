/**
 * BUG-A8: Контекст для чтения настроек в бот-флоу.
 *
 * app.option.get в Bitrix24 требует OAuth-контекст ПРИЛОЖЕНИЯ.
 * Вебхук-контекст возвращает 403 ACCESS_DENIED "Application context required".
 *
 * Правило выбора:
 * - adminContext непустой → использовать его (OAuth-приложение умеет app.option.get)
 * - иначе → webhookContext (фоллбэк; composite-стор уйдёт в DB-кэш)
 * - оба отсутствуют → {} (composite-стор читает из DB)
 *
 * @param {{ adminContext?: object, webhookContext?: object }} params
 * @returns {object}
 */
export const resolveBotSettingsContext = ({ adminContext, webhookContext }) => {
  if (adminContext && Object.keys(adminContext).length > 0) {
    return adminContext;
  }
  return webhookContext || {};
};
