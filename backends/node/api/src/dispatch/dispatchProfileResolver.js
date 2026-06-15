/**
 * S8-A1: Резолвер профиля рассылки для конкретной АЗС.
 *
 * Чистая функция — не имеет побочных эффектов, полностью тестируемая.
 *
 * Логика (§3.3 спеки):
 *   - Перебираем profiles по порядку; возвращаем первый профиль, в котором есть azsId.
 *   - Если АЗС не найдена ни в одном профиле → null (бэкенд обеспечивает «По умолчанию»).
 *   - Если одна АЗС присутствует в нескольких профилях (конфиг-ошибка) — возвращаем первый
 *     матч и пишем предупреждение в stderr (валидация на уровне PUT /settings уже блокирует
 *     такие конфиги, но резолвер обязан быть устойчивым).
 */

/**
 * @param {string} azsId — строковый ID карточки АЗС из CRM
 * @param {{ dispatchProfiles?: Array<{id: string, name: string, azsIds: string[], mode: 'A'|'B', config: object}> }} settings
 * @returns {object|null} — профиль или null (АЗС не в профиле → «По умолчанию»)
 */
export const resolveProfileForAzs = (azsId, settings) => {
  const profiles = settings?.dispatchProfiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return null;
  }

  let firstMatch = null;
  let matchCount = 0;

  for (const profile of profiles) {
    if (Array.isArray(profile.azsIds) && profile.azsIds.includes(azsId)) {
      matchCount += 1;
      if (firstMatch === null) {
        firstMatch = profile;
      }
    }
  }

  if (matchCount > 1) {
    // Конфиг-ошибка: одна АЗС в нескольких профилях. Возвращаем первый, логируем.
    console.warn(
      `[dispatchProfileResolver] azsId '${azsId}' found in ${matchCount} profiles; ` +
      `using first match '${firstMatch.id}'. Fix dispatchProfiles configuration.`
    );
  }

  return firstMatch;
};
