/**
 * diagChatNotifier — best-effort уведомление команды о новом диагностическом
 * бандле: короткая карточка + сам бандл файлом в JSON, в дежурный чат.
 *
 * Бандл к этому моменту уже сохранён в diag_report (см. diagRoutes.js) — эта
 * часть работы только ИНФОРМИРУЕТ, поэтому её провал не имеет права:
 *  - изменить HTTP-ответ оператору,
 *  - бросить исключение наружу,
 *  - потерять уже сохранённый бандл.
 * notify() поэтому никогда не бросает и всегда резолвится.
 *
 * Формат отправки — тот же, что уже используют photoRemarkService.js
 * (imbot.v2.File.upload: один вызов одновременно грузит файл И постит
 * сообщение) и notificationService.js/reasonForwardingService.js
 * (imbot.v2.Chat.Message.send для текста без вложения).
 *
 * Id бота НЕ читается из BITRIX_BOT_ID при создании нотифаера. В этом
 * проекте бот регистрирует себя сам через botRegistryService — его id не
 * известен заранее и не может жить в переменной окружения (BITRIX_BOT_ID=0
 * в проде — нормальное состояние, не ошибка конфигурации). Поэтому id
 * резолвится ВНУТРИ notify(), на каждый вызов, той же функцией
 * resolveBotId(context), что уже получает notificationService в server.js —
 * см. createDiagChatNotifier ниже. Прежняя версия читала
 * process.env.BITRIX_BOT_ID при создании нотифаера и получала 0 — не «бот
 * не настроен», а «бот ещё не зарегистрирован», два разных факта. Нотифаер
 * молча считал себя выключенным в проде при верно заданном DIAG_CHAT_ID.
 */

const TRIGGER_LABELS = {
  button: 'нажатие оператора «Что-то не работает»',
  auto_upload_error: 'автоматически при сбое загрузки'
};

const describeTrigger = (trigger) => TRIGGER_LABELS[trigger] || 'неизвестно';

const roundOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

/**
 * Время бандла — в часовом поясе портала (Europe/Moscow по умолчанию, тот же
 * фолбэк, что и в notificationService.js/reasonForwardingService.js), а не в
 * UTC ISO: карточка читается человеком на телефоне, а не парсится кодом.
 */
const formatMoscowDateTime = (iso) => {
  const raw = String(iso || '').trim();
  if (!raw) return 'время неизвестно';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return 'время неизвестно';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString();
  }
};

const describeAzs = (bundle) => {
  const azsId = bundle?.user?.azsId;
  const value = azsId === undefined || azsId === null ? '' : String(azsId).trim();
  return value || 'не определена';
};

/**
 * Замер канала — только числа и факты (скорость эхо-пробы, тип соединения),
 * никогда не формулировка вида «плохой интернет у оператора»: это измерение,
 * а не обвинение (см. бриф задачи).
 */
const describeChannel = (bundle) => {
  const probe = bundle?.probe && typeof bundle.probe === 'object' ? bundle.probe : {};
  const network = bundle?.network && typeof bundle.network === 'object' ? bundle.network : {};
  const parts = [];

  const kbps = roundOrNull(probe.echoKbps);
  if (kbps !== null) parts.push(`${kbps} Кбит/с`);

  const echoMs = roundOrNull(probe.echoMs);
  if (echoMs !== null) parts.push(`эхо-проба ${echoMs} мс`);

  if (network.effectiveType) parts.push(String(network.effectiveType));
  if (network.onLine === false) parts.push('офлайн на момент отправки');

  return parts.length ? parts.join(', ') : 'нет данных';
};

/** Пинг — отдельной строкой и только когда он вообще был измерен. */
const describePing = (bundle) => {
  const probe = bundle?.probe && typeof bundle.probe === 'object' ? bundle.probe : {};
  const ms = roundOrNull(probe.pingMsMedian);
  if (ms === null) return null;
  const loss = typeof probe.pingLoss === 'number' ? `, потери ${Math.round(probe.pingLoss)}%` : '';
  return `${ms} мс${loss}`;
};

/**
 * Наша сторона: живая проба Диска и её код ошибки — НЕ errorMessage (это
 * свободный текст; даже редактированный, ему не место в карточке-сводке),
 * только устойчивый код вроде wrong_client/expired_token (см. serverSelfCheck.js).
 */
const describeDisk = (serverSlice) => {
  const disk = serverSlice?.disk;
  if (!disk) return 'нет данных';
  if (disk.ok) {
    const ms = roundOrNull(disk.ms);
    return ms !== null ? `OK (${ms} мс)` : 'OK';
  }
  return disk.errorCode ? `ошибка (${disk.errorCode})` : 'ошибка';
};

/** OAuth — только факт наличия сохранённого контекста, без домена/id. */
const describeOauth = (serverSlice) => {
  const oauth = serverSlice?.oauth;
  if (!oauth) return 'нет данных';
  return oauth.hasContext ? 'есть' : 'отсутствует';
};

const countErrors = (bundle) => (Array.isArray(bundle?.errors) ? bundle.errors.length : 0);

const countFailedUploads = (bundle) => {
  const uploads = Array.isArray(bundle?.uploads) ? bundle.uploads : [];
  const failed = uploads.filter((entry) => entry?.outcome === 'error').length;
  return { failed, total: uploads.length };
};

/**
 * Карточка — короткая и читаемая с телефона за пару секунд: что случилось,
 * где, наша сторона в порядке или нет. Только факты и числа, никакого жаргона
 * и никакой оценки оператора.
 */
export const buildCardText = ({ code, bundle, serverSlice }) => {
  const { failed: failedUploads, total: totalUploads } = countFailedUploads(bundle);
  const ping = describePing(bundle);

  const lines = [
    `Диагностика ${code} — АЗС ${describeAzs(bundle)}`,
    formatMoscowDateTime(bundle?.sentAt),
    `Отправлено: ${describeTrigger(bundle?.trigger)}`,
    '',
    `Канал: ${describeChannel(bundle)}`
  ];
  if (ping) lines.push(`Пинг: ${ping}`);
  lines.push('');
  lines.push(`Диск Битрикса: ${describeDisk(serverSlice)}`);
  lines.push(`OAuth-контекст: ${describeOauth(serverSlice)}`);
  lines.push('');
  lines.push(`Ошибок в логе: ${countErrors(bundle)}`);
  lines.push(`Неудачных загрузок: ${failedUploads} из ${totalUploads}`);
  lines.push('');
  lines.push(`Код: ${code}`);

  return lines.join('\n');
};

const buildFileName = (code) => `diag-${code}.json`;

/**
 * createDiagChatNotifier({ bitrixClient, dialogId, resolveContext, resolveBotId, logger })
 *   → { notify({ code, bundle, serverSlice }) }
 *
 * dialogId — готовая строка вида "chat22574" (см. reasonForwardingService.js,
 * где chatId из настроек ЧИСЛОВОЙ и префикс "chat" добавляется на месте; здесь
 * DIAG_CHAT_ID уже приходит как полный dialogId — префиксовать не нужно).
 * Единственное, что решает «включена ли фича»: id бота заранее не известен
 * (см. заголовок файла) и на это решение не влияет.
 *
 * resolveContext — та же функция, что server.js передаёт как getAdminContext
 * в photoRemarkService/usersRoutes/brandRoutes и т.д. Оба метода imbot.v2.*
 * принимают auth-контекст третьим аргументом callMethod; без него (пустой {})
 * вызов уходит под контекстом, которого Bitrix не узнаёт, и падает, не покинув
 * наш сервер, — это уже происходило с соседним модулем этой же фичи.
 *
 * resolveBotId(context) — та же функция (по форме), что server.js передаёт
 * notificationService как resolveBotId: async (context) => ... с той же
 * логикой поверх botRegistryService.ensureBot. Вызывается на каждый notify()
 * с уже разрешённым auth-контекстом (authId живёт внутри него), а не при
 * создании нотифаера — id бота становится известен только после того, как
 * botRegistryService его зарегистрировал/нашёл, что само требует authId из
 * контекста конкретного запроса. Раз id недоверенный источник может вернуть
 * что угодно (throw, не-число, отрицательное), контракт notify() «никогда не
 * бросает» защищает и от этого вызова, не только от bitrixClient.callMethod.
 */
export const createDiagChatNotifier = ({
  bitrixClient,
  dialogId = null,
  resolveContext = null,
  resolveBotId = null,
  logger = console
} = {}) => {
  if (!bitrixClient) {
    throw new Error('bitrixClient is required');
  }

  const trimmedDialogId = String(dialogId || '').trim();
  // Id бота НЕ участвует в этом решении: он резолвится позже, за пределами
  // конструктора (см. комментарий выше и notify() ниже). «Выключено» здесь
  // означает ровно одно — DIAG_CHAT_ID пуст, владелец не задал чат.
  const enabled = trimmedDialogId.length > 0;

  const resolveAuthContext = async () => {
    if (typeof resolveContext !== 'function') return {};
    try {
      const ctx = await resolveContext();
      return ctx || {};
    } catch (error) {
      logger.warn('diag_chat_notify_context_failed', { message: error?.message || String(error) });
      return {};
    }
  };

  /**
   * Резолвит id бота под уже разрешённый auth-контекст. Untrusted-граница:
   * resolveBotId — колбэк снаружи модуля (в проде — обёртка над
   * botRegistryService.ensureBot, которая сама ходит в Bitrix), поэтому throw
   * отсюда ловится здесь же и никогда не долетает до notify() как есть —
   * просто становится «id не резолвился», той же формы, что и botId=0.
   */
  const resolveRuntimeBotId = async (context) => {
    if (typeof resolveBotId !== 'function') return 0;
    try {
      return Number(await resolveBotId(context)) || 0;
    } catch (error) {
      logger.warn('diag_chat_resolve_bot_id_threw', { message: error?.message || String(error) });
      return 0;
    }
  };

  /**
   * notify — контракт: никогда не бросает, всегда резолвится. Store-first —
   * это уже случилось до вызова notify() (см. diagRoutes.js); здесь только
   * лучшая попытка сообщить об этом команде.
   */
  const notify = async ({ code, bundle, serverSlice = null }) => {
    if (!enabled) {
      return { ok: false, delivered: false, disabled: true, reason: 'chat_notifier_disabled' };
    }

    try {
      const cardText = buildCardText({ code, bundle, serverSlice });
      // Контекст резолвится ПЕРВЫМ: id бота ищется/регистрируется под authId
      // ИЗ этого контекста (см. resolveRuntimeBotId выше и server.js:356-363,
      // где notificationService делает то же самое в том же порядке).
      const context = await resolveAuthContext();
      const numericBotId = await resolveRuntimeBotId(context);

      if (!numericBotId) {
        // Другая ситуация, чем «фича выключена» (см. заголовок файла и
        // enabled выше) — DIAG_CHAT_ID задан, значит владелец ХОЧЕТ доставку,
        // но бот не зарегистрирован/не резолвится. Это стоит видеть в логах
        // отдельной строкой, а не тонуть в «disabled» тишине.
        logger.warn('diag_chat_no_bot', { code });
        return { ok: false, delivered: false, reason: 'no_bot_id' };
      }

      try {
        // Один вызов грузит JSON-файл с полным бандлом И постит карточку —
        // см. photoRemarkService.js:112, тот же imbot.v2.File.upload.
        const payload = JSON.stringify({ bundle, serverSlice }, null, 2);
        const base64 = Buffer.from(payload, 'utf8').toString('base64');
        await bitrixClient.callMethod('imbot.v2.File.upload', {
          botId: numericBotId,
          dialogId: trimmedDialogId,
          fields: {
            name: buildFileName(code),
            content: base64,
            message: cardText
          }
        }, context);
        return { ok: true, delivered: true, channel: 'file' };
      } catch (uploadError) {
        logger.warn('diag_chat_notify_upload_failed', {
          code,
          message: uploadError?.message || String(uploadError)
        });

        try {
          const fallbackText = `${cardText}\n\nФайл диагностики прикрепить не удалось — бандл доступен в базе по коду ${code}.`;
          await bitrixClient.callMethod('imbot.v2.Chat.Message.send', {
            botId: numericBotId,
            dialogId: trimmedDialogId,
            fields: { message: fallbackText, urlPreview: false }
          }, context);
          return { ok: true, delivered: true, channel: 'text_fallback' };
        } catch (fallbackError) {
          logger.error('diag_chat_notify_failed', {
            code,
            message: fallbackError?.message || String(fallbackError)
          });
          return { ok: false, delivered: false, channel: null, reason: 'fallback_failed' };
        }
      }
    } catch (unexpectedError) {
      // Защита от бага в самой карточке (например, неожиданная форма bundle) —
      // даже такой сбой не имеет права всплыть исключением из notify().
      logger.error('diag_chat_notify_unexpected_error', {
        code,
        message: unexpectedError?.message || String(unexpectedError)
      });
      return { ok: false, delivered: false, channel: null, reason: 'unexpected_error' };
    }
  };

  return { notify };
};

export default createDiagChatNotifier;
