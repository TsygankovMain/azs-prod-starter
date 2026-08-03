/**
 * photoPublishWatchdog — сторож застрявших фото очереди публикации.
 *
 * Контекст: приём фото переведён в фоновую публикацию (photoQueueStore.js) —
 * оператор получает "Принято" сразу, а доставка в Битрикс идёт отдельным
 * воркером. Обратная сторона этого решения: поломка воркера/портала больше
 * НЕ видна на экране оператора. Раньше отказ был явной ошибкой загрузки,
 * теперь он рискует стать тихой потерей, о которой никто не узнает —
 * отсутствие жалоб перестаёт означать "всё хорошо". Этот модуль — то, что это
 * компенсирует: он периодически проверяет очередь и сигналит живому человеку
 * в чат, если что-то само доехать не может.
 *
 * Данные — ТОЛЬКО photoQueueStore.listStuck(), никакого собственного SQL.
 * Стор уже отдаёт ровно то, что нужно, и делает это НЕ по одному правилу:
 * помимо фото старше olderThanMs, он немедленно включает в выборку
 *   - фото без байтов (приём прервался между двумя вставками),
 *   - фото в состоянии 'failed' (окончательная ошибка — квота Диска
 *     исчерпана, папка удалена, нет прав) —
 * то есть уже сам решает "не дожидаясь порога" для этих двух категорий (см.
 * комментарий над listStuck в photoQueueStore.js). Поэтому здесь НЕТ и не
 * должно появиться повторной фильтрации строк по возрасту: строки от
 * listStuck() берутся как есть и целиком доверяются его решению — только это
 * и превращает "failed попадает сразу" в правду, а не в состояние гонки с
 * тем, до какого порога доросло это конкретное фото.
 *
 * Приватность: listStuck() не возвращает ни байты фото, ни EXIF (это поля
 * report_photo_blob/claimBatch, не listStuck) — их физически неоткуда взять
 * даже по ошибке. Но describeStuckRow() ниже всё равно строит исходящий
 * объект через явный список полей, а не через spread ...row, — тем же
 * приёмом, что не даёт случайно протечь ничему за пределами списка "номер
 * АЗС/отчёта, код слота, сколько висит, последняя ошибка", даже если форма
 * строки когда-нибудь изменится.
 *
 * notify — уже готовая, ВНЕШНЯЯ функция постановки сообщения в чат (образец
 * — diagChatNotifier.js: id бота резолвится в рантайме через
 * botRegistryService.ensureBot, а не читается из BITRIX_BOT_ID, который в
 * проде честно равен нулю до саморегистрации бota). Этот модуль не знает
 * про Bitrix вообще — resolveBotId/dialogId/imbot.v2.* целиком забота
 * стороны, которая строит notify (проводка в server.js — Task 11). НО, в
 * отличие от diagChatNotifier, чей собственный notify() гарантирует "никогда
 * не бросает", здесь notify — недоверенная граница: это инжектированная
 * функция, и её реализация может оказаться как раз diagChatNotifier.notify
 * (не бросает) или куда более простой обёрткой, которая бросает как обычная
 * async-функция. Сторож не имеет права полагаться на чужую гарантию — он
 * оборачивает вызов notify сам (см. runOnce ниже). Это и есть "не наступить
 * на те же грабли": не считать чужой контракт данностью без проверки.
 *
 * Анти-спам и напоминание: два тика подряд с одним и тем же набором
 * застрявших фото обязаны дать ровно одно сообщение (иначе один зависший
 * файл будет писать в чат на каждом тике) — но и молчать вечно про
 * ДЕРЖАЩУЮСЯ проблему нельзя (иначе тишина после первого сообщения снова
 * начнёт означать "всё хорошо", ровно то, чего этот модуль обязан не
 * допустить). Решение: "подпись" набора (buildSignature) плюс
 * reminderIntervalMs — тот же набор коротко после сигнала подавляется
 * дедупом, а спустя reminderIntervalMs сигналит снова, пока не решится.
 * Любое изменение набора (новый застрявший файл, другая ошибка у уже
 * известного) считается новой проблемой и сигналит немедленно, не дожидаясь
 * ни дедупа, ни напоминания.
 */

import { createGuardedTick } from '../shared/guardedTick.js';

const readEnvMs = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

// 2 часа — покрывает полный слив парка (1 ч 13 мин при 2 запросах в секунду
// порталу) с большим запасом, поэтому здоровая очередь никогда не держит
// фото так долго просто в силу собственной пропускной способности: нормальная
// работа сторожа не должна будить человека. Если что-то лежит дольше — это
// уже не "воркер не успел", а отдельная, достойная сигнала проблема.
const DEFAULT_STUCK_AFTER_MS = readEnvMs('PHOTO_STUCK_AFTER_MS', 2 * 60 * 60 * 1000);

// Тик — лёгкая операция (один SELECT, почти всегда с пустым результатом),
// частый опрос ничего не стоит и позволяет быстрее заметить "немедленную"
// категорию (фото без байтов/failed).
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Не спамить одним и тем же, но и не молчать вечно: если один и тот же набор
// застрявших фото держится долго, человек должен периодически получать
// напоминание, а не решить по тишине, что всё само починилось. 30 минут —
// заметно дольше тика (не спам на каждом цикле), но достаточно часто в
// масштабе смены (обычно 8–12 часов), чтобы напоминание не потерялось.
const DEFAULT_REMINDER_INTERVAL_MS = 30 * 60 * 1000;

// Сторож существует, чтобы позвать человека, а не чтобы прислать ему выгрузку
// всей базы — предел на то, сколько строк вообще запрашивается за тик.
const DEFAULT_LIST_LIMIT = 100;

// Отдельно от предела выборки — сколько строк показать построчно в самом
// сообщении. Даже сто строк текстом в чате нечитаемы, а точный список сверх
// первых нескольких не добавляет ничего важного, чего не даёт уже счётчик.
const MAX_DISPLAY_ITEMS = 20;

const toMillis = (value) => {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const formatDuration = (ms) => {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'неизвестно';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
};

/**
 * Сырую строку listStuck() превращает в то, что безопасно показать и
 * передать наружу: report_id (единственный идентификатор "какой отчёт/АЗС",
 * который listStuck отдаёт БЕЗ дополнительного join — join на dispatch_log
 * ради настоящего azs_id сюда сознательно не добавлен, см. заголовок файла и
 * "Не переизобретай выборку" в задании), код слота, сколько висит, последняя
 * ошибка. Явный список полей вместо spread ...row — намеренно: так лишнее
 * поле в строке (например, если форма listStuck когда-нибудь расширится)
 * не может протечь наружу незамеченным.
 */
const describeStuckRow = (row, nowMs) => {
  const uploadedAtMs = toMillis(row?.uploaded_at);
  const stuckForMs = uploadedAtMs === null ? null : Math.max(0, nowMs - uploadedAtMs);
  return {
    id: row?.id,
    reportId: row?.report_id,
    photoCode: row?.photo_code,
    attempts: Number(row?.publish_attempts || 0),
    stuckForMs,
    lastError: row?.last_publish_error || null
  };
};

/**
 * Стабильная "подпись" текущего набора застрявших фото — основа анти-спама.
 * last_publish_error входит в подпись намеренно: смена ошибки на другую
 * (например, ретрай перестал быть таймаутом и стал окончательным отказом
 * Диска) — новая информация, достойная отдельного сигнала, а не немого
 * поглощения дедупом. sort() — чтобы порядок строк (у listStuck он
 * стабилен по uploaded_at, но это не входит в контракт этого модуля) не
 * менял саму подпись.
 */
const buildSignature = (items) => items
  .map((item) => `${item.id}:${item.lastError || ''}`)
  .sort()
  .join('|');

const buildMessageText = ({ items, totalCount, limitReached }) => {
  const countLabel = limitReached ? `не менее ${totalCount}` : String(totalCount);
  const lines = [`Сторож публикации фото: застряло ${countLabel}.`, ''];

  for (const item of items.slice(0, MAX_DISPLAY_ITEMS)) {
    const errorPart = item.lastError ? `, последняя ошибка: ${item.lastError}` : '';
    lines.push(`Отчёт ${item.reportId}, слот ${item.photoCode}: висит ${formatDuration(item.stuckForMs)}${errorPart}`);
  }
  if (items.length > MAX_DISPLAY_ITEMS) {
    lines.push('', `…и ещё ${items.length - MAX_DISPLAY_ITEMS}, не показаны`);
  }

  return lines.join('\n');
};

export const createPhotoPublishWatchdog = ({
  store,
  notify,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  reminderIntervalMs = DEFAULT_REMINDER_INTERVAL_MS,
  limit = DEFAULT_LIST_LIMIT,
  now = () => Date.now(),
  logger = console
} = {}) => {
  if (!store || typeof store.listStuck !== 'function') {
    throw new Error('store with listStuck() is required');
  }
  if (typeof notify !== 'function') {
    throw new Error('notify must be a function');
  }

  // Память о последнем сигнале: что именно сообщили и когда. Оба поля
  // сбрасываются, как только застрявших не остаётся — если проблема потом
  // появится заново, это обязан быть новый сигнал, а не подавленный дубликат
  // старой, уже неактуальной памяти.
  let lastSignature = null;
  let lastNotifiedAtMs = -Infinity;

  const runOnce = async () => {
    const rows = await store.listStuck({ olderThanMs: stuckAfterMs, limit });

    if (!rows.length) {
      lastSignature = null;
      lastNotifiedAtMs = -Infinity;
      return { stuckCount: 0, notified: false };
    }

    const nowMs = now();
    const items = rows.map((row) => describeStuckRow(row, nowMs));
    const signature = buildSignature(items);

    const sameProblemAsLastTime = signature === lastSignature;
    const reminderDue = (nowMs - lastNotifiedAtMs) >= reminderIntervalMs;

    // Анти-спам: тот же самый набор недавно уже сообщили — не повторяем на
    // каждом тике. Но не молчим вечно: если проблема держится дольше
    // reminderIntervalMs, сигнал намеренно повторяется (см. заголовок файла).
    if (sameProblemAsLastTime && !reminderDue) {
      return { stuckCount: rows.length, notified: false, deduped: true };
    }

    const text = buildMessageText({
      items,
      totalCount: rows.length,
      limitReached: rows.length >= limit
    });

    try {
      await notify({ count: rows.length, items, text });
      lastSignature = signature;
      lastNotifiedAtMs = nowMs;
      return { stuckCount: rows.length, notified: true };
    } catch (error) {
      // Сторож не имеет права молчать из-за собственной поломки: падение
      // notify (чат недоступен, бот не резолвится, что угодно ещё) обязано
      // остаться в логе и НЕ уронить тик. lastSignature/lastNotifiedAtMs
      // намеренно НЕ обновляются здесь: раз доставка не удалась, это не
      // "уже предупредили", и следующий тик обязан попробовать снова, а не
      // ждать целый reminderIntervalMs просто потому, что попытка была.
      logger.error('photo_publish_watchdog_notify_failed', {
        message: error?.message || String(error),
        stuckCount: rows.length
      });
      return { stuckCount: rows.length, notified: false, error: true };
    }
  };

  // Overlap guard: если store.listStuck/notify когда-нибудь начнут отвечать
  // дольше intervalMs, второй тик обязан пропустить себя, а не запускать
  // параллельную проверку той же очереди.
  const tick = createGuardedTick({
    runOnce,
    onSkip: () => logger.warn('photo_publish_watchdog_tick_skipped_overlap')
  });

  let timer = null;

  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((error) => {
        // guardedTick не глотает ошибки runOnce (см. shared/guardedTick.js) —
        // сам runOnce уже не бросает по вине notify (см. try/catch выше), но
        // если когда-нибудь бросит store.listStuck (например, БД недоступна),
        // это не должно уронить процесс через необработанный rejection
        // внутри таймера.
        logger.error('photo_publish_watchdog_tick_failed', {
          message: error?.message || String(error)
        });
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { tick, start, stop };
};

export default createPhotoPublishWatchdog;
