#!/usr/bin/env node
/**
 * BUG-8709 — пересчёт истории: привести стадии элементов СП «Фотоотчет»
 * (entityTypeId 1116) в соответствие с журналом приложения (dispatch_log).
 *
 * ЗАЧЕМ. С конца июля перевод стадии в CRM был привязан ТОЛЬКО к завершению
 * публикации фото, а сдача смены (POST /:id/submit) задачу в очередь больше
 * не ставила. Публикация почти всегда заканчивается на секунду-две раньше,
 * чем оператор жмёт «сдать», поэтому задача выполнялась, пока отчёт ещё был
 * 'in_progress', и писала стадию «в работе». После сдачи повторить перевод
 * было нечем. Итог на 06.09.2026: 3246 сдач за июнь–сентябрь, из них в
 * SUCCESS — сотни, остальные висят в PREPARATION (с августа) или NEW (июль).
 * Сам баг починен в коде (photoPublishCompletion.js + /:id/submit); этот
 * скрипт разбирает уже накопленный хвост.
 *
 * ЧТО ДЕЛАЕТ. Читает dispatch_log (ТОЛЬКО SELECT), берёт строки со
 * status='done' и непустым report_item_id за указанный период, читает
 * фактические стадии этих элементов пачками через crm.item.list и переводит
 * в done-стадию те и только те, что застряли в «новая»/«в работе».
 *
 * ЧЕГО НЕ ДЕЛАЕТ (осознанно):
 *   • не трогает элементы в любой стадии, кроме NEW/PREPARATION. FAIL —
 *     корректный итог просрочки (выборочная проверка: просроченные лежат в
 *     FAIL, их чинить не надо). UC_07G901 («отклонён») — РЕШЕНИЕ ЧЕЛОВЕКА,
 *     перебивать его машинно нельзя ни при каких условиях;
 *   • не пишет в БД приложения вообще ничего;
 *   • не трогает статусы, кроме 'done' ('cancelled'/'failed' стадии не имеют,
 *     'expired' уже разложен корректно);
 *   • не заполняет ни папку Диска, ни поле с фотографиями — только стадию.
 *     Пересчёт истории обязан быть минимальным по площади касания.
 *
 * ИДЕМПОТЕНТНОСТЬ. Двойная. (1) Перед каждой записью стадия читается заново,
 * и элемент, уже находящийся в целевой стадии, пропускается — повторный
 * запуск ничего не пишет. (2) Журнал прогона (--state-file, JSONL) даёт
 * дешёвое возобновление после обрыва: обработанные id пропускаются без
 * единого запроса к порталу.
 *
 * ЗАПУСК (dry-run — поведение ПО УМОЛЧАНИЮ, без --apply не пишется ничего).
 * Единственная внешняя зависимость — драйвер pg; он уже стоит у бэкенда,
 * поэтому запускать проще всего с его node_modules:
 *
 *   cd backends/node/api && pnpm install --frozen-lockfile   # если ещё не стоял
 *   export NODE_PATH="$PWD/backends/node/api/node_modules"    # из корня репозитория
 *
 *   export DATABASE_URL='postgres://user:pass@host:5432/BD_AZS'
 *   export BITRIX_WEBHOOK_URL='https://ortk.bitrix24.ru/rest/<user>/<token>/'
 *
 *   # 1. Посмотреть план целиком
 *   node scripts/backfill-report-stages.mjs --from 2026-06-01 --to 2026-09-07
 *
 *   # 2. Прогнать боевую запись на маленькой пробе (один день)
 *   node scripts/backfill-report-stages.mjs --from 2026-09-05 --to 2026-09-06 --apply
 *
 *   # 3. Убедиться в отчётности клиента, что сентябрь сошёлся, и только потом
 *   #    раскатывать на весь период — от свежего к старому, по месяцу за раз
 *   node scripts/backfill-report-stages.mjs --from 2026-08-01 --to 2026-09-01 --apply
 *
 * ФЛАГИ:
 *   --from YYYY-MM-DD   начало периода (включительно), по умолчанию 2026-06-01
 *   --to   YYYY-MM-DD   конец периода (исключительно), по умолчанию завтра
 *   --apply             выполнить запись; без него — только план
 *   --limit N           обработать не больше N элементов (проба)
 *   --rps N             темп записи, запросов в секунду (по умолчанию 2)
 *   --state-file PATH   журнал прогона, по умолчанию ./backfill-report-stages.jsonl
 *   --entity-type-id N  переопределить entityTypeId (по умолчанию 1116)
 *   --done-stage ID     переопределить целевую стадию (по умолчанию DT1116_44:SUCCESS)
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// --- Настройки предметной области -----------------------------------------
// Совпадают с app_settings портала ortk.bitrix24.ru (ключ report.stages).
// Вынесены в константы, а не читаются из БД, намеренно: пересчёт истории
// должен делать ровно то, что написано в его же исходнике, и быть
// воспроизводимым спустя месяцы, когда настройки на портале уже поменяют.
const DEFAULT_ENTITY_TYPE_ID = 1116;
const DEFAULT_DONE_STAGE = 'DT1116_44:SUCCESS';
// Только эти две стадии считаются «залипшими» и подлежат переводу.
const REPAIRABLE_STAGES = new Set(['DT1116_44:NEW', 'DT1116_44:PREPARATION']);

const READ_CHUNK = 50;   // сколько id читаем одним crm.item.list
const DEFAULT_RPS = 2;   // устойчивый темп записи в портал

// --- Разбор аргументов -----------------------------------------------------

const parseArgs = (argv) => {
  const args = { apply: false, from: '2026-06-01', to: null, limit: 0, rps: DEFAULT_RPS,
    stateFile: 'backfill-report-stages.jsonl', entityTypeId: DEFAULT_ENTITY_TYPE_ID, doneStage: DEFAULT_DONE_STAGE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--apply') args.apply = true;
    else if (a === '--from') args.from = next();
    else if (a === '--to') args.to = next();
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--rps') args.rps = Number(next());
    else if (a === '--state-file') args.stateFile = next();
    else if (a === '--entity-type-id') args.entityTypeId = Number(next());
    else if (a === '--done-stage') args.doneStage = next();
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  if (!args.to) {
    const t = new Date(Date.now() + 24 * 3600e3);
    args.to = t.toISOString().slice(0, 10);
  }
  for (const key of ['from', 'to']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args[key]))) throw new Error(`--${key} должен быть в формате YYYY-MM-DD`);
  }
  if (!Number.isFinite(args.rps) || args.rps <= 0) throw new Error('--rps должен быть положительным числом');
  return args;
};

// --- Клиент портала --------------------------------------------------------

const makeBitrix = (webhookBase) => {
  const base = String(webhookBase || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+$/.test(base)) {
    throw new Error('BITRIX_WEBHOOK_URL должен выглядеть как https://<портал>/rest/<userId>/<token>/');
  }
  return async (method, params) => {
    const res = await fetch(`${base}/${method}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${method}: не-JSON ответ HTTP ${res.status}: ${text.slice(0, 300)}`); }
    // Ответы REST Битрикса нельзя принимать на веру по одному только HTTP-коду:
    // проверяем и код, и поле error, и наличие result.
    if (!res.ok || json?.error) {
      throw new Error(`${method}: HTTP ${res.status} ${json?.error || ''} ${json?.error_description || text.slice(0, 200)}`);
    }
    if (!('result' in json)) throw new Error(`${method}: в ответе нет result: ${text.slice(0, 200)}`);
    return json.result;
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Журнал прогона --------------------------------------------------------

const loadState = (file) => {
  const seen = new Map();
  if (!fs.existsSync(file)) return seen;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row?.itemId) seen.set(Number(row.itemId), row.outcome); } catch { /* битая строка журнала не повод падать */ }
  }
  return seen;
};

const appendState = (file, row) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8');
};

// --- Основной ход ----------------------------------------------------------

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Не задан DATABASE_URL (строка подключения к BD_AZS, достаточно прав только на SELECT)');
  const call = makeBitrix(process.env.BITRIX_WEBHOOK_URL);

  const mode = args.apply ? 'ЗАПИСЬ' : 'DRY-RUN (ничего не пишется)';
  console.log(`[BUG-8709] режим: ${mode}; период ${args.from} .. ${args.to}; целевая стадия ${args.doneStage}`);

  // 1. Кандидаты из журнала приложения. ТОЛЬКО SELECT.
  const client = new pg.Client({ connectionString });
  await client.connect();
  let rows;
  try {
    const result = await client.query(
      `SELECT id AS report_id, report_item_id, slot_key, azs_id, updated_at
         FROM dispatch_log
        WHERE status = 'done'
          AND report_item_id IS NOT NULL
          AND COALESCE(scheduled_at, created_at) >= $1::date
          AND COALESCE(scheduled_at, created_at) <  $2::date
        ORDER BY id DESC`,
      [args.from, args.to]
    );
    rows = result.rows;
  } finally {
    await client.end();
  }
  console.log(`[BUG-8709] сдач в журнале приложения за период: ${rows.length}`);

  // 2. Отсев уже обработанных прошлым прогоном.
  const seen = loadState(args.stateFile);
  let candidates = rows.filter((r) => !seen.has(Number(r.report_item_id)));
  if (seen.size) console.log(`[BUG-8709] пропущено по журналу прогона (${args.stateFile}): ${rows.length - candidates.length}`);
  if (args.limit > 0) candidates = candidates.slice(0, args.limit);

  // 3. Фактические стадии — пачками по READ_CHUNK.
  const stages = new Map();
  for (let i = 0; i < candidates.length; i += READ_CHUNK) {
    const chunk = candidates.slice(i, i + READ_CHUNK).map((r) => Number(r.report_item_id));
    const result = await call('crm.item.list', {
      entityTypeId: args.entityTypeId,
      filter: { '@id': chunk },
      select: ['id', 'stageId']
    });
    for (const item of result?.items || []) stages.set(Number(item.id), String(item.stageId || ''));
    await sleep(1000 / args.rps);
    process.stdout.write(`\r[BUG-8709] прочитано стадий: ${stages.size}/${candidates.length}   `);
  }
  process.stdout.write('\n');

  // 4. Раскладка по решениям.
  const plan = [];
  const summary = { repair: 0, already_done: 0, rejected_by_human: 0, expired_stage: 0, other_stage: 0, not_found: 0 };
  for (const row of candidates) {
    const itemId = Number(row.report_item_id);
    const stage = stages.get(itemId);
    if (stage === undefined) { summary.not_found += 1; continue; }        // элемент удалён с портала
    if (stage === args.doneStage) { summary.already_done += 1; continue; }
    if (stage === 'DT1116_44:UC_07G901') { summary.rejected_by_human += 1; continue; }
    if (stage === 'DT1116_44:FAIL') { summary.expired_stage += 1; continue; }
    if (!REPAIRABLE_STAGES.has(stage)) { summary.other_stage += 1; continue; }
    summary.repair += 1;
    plan.push({ reportId: Number(row.report_id), itemId, from: stage, slotKey: row.slot_key, azsId: row.azs_id });
  }

  console.table(summary);
  console.log(`[BUG-8709] к переводу в ${args.doneStage}: ${plan.length}`);
  for (const p of plan.slice(0, 20)) console.log(`  #${p.itemId} (отчёт ${p.reportId}, АЗС ${p.azsId}, ${p.slotKey}): ${p.from} -> ${args.doneStage}`);
  if (plan.length > 20) console.log(`  ... и ещё ${plan.length - 20}`);

  if (!args.apply) {
    console.log('[BUG-8709] dry-run: запись не выполнялась. Повторите с --apply, когда план устроит.');
    return;
  }

  // 5. Запись. По одному элементу, с перечиткой стадии, под ограничением темпа.
  let updated = 0; let skipped = 0; let failed = 0;
  for (const p of plan) {
    try {
      // Перечитка перед записью: между шагом 3 и этим моментом карточку мог
      // тронуть человек. Ещё это и есть вторая половина идемпотентности —
      // повторный запуск здесь ничего не запишет.
      const fresh = await call('crm.item.get', { entityTypeId: args.entityTypeId, id: p.itemId });
      const freshStage = String(fresh?.item?.stageId || '');
      await sleep(1000 / args.rps);
      if (!REPAIRABLE_STAGES.has(freshStage)) {
        skipped += 1;
        appendState(args.stateFile, { itemId: p.itemId, reportId: p.reportId, outcome: 'skipped', stage: freshStage });
        continue;
      }
      await call('crm.item.update', { entityTypeId: args.entityTypeId, id: p.itemId, fields: { stageId: args.doneStage } });
      await sleep(1000 / args.rps);
      // Проверка записи: ответ REST Битрикса сам по себе не доказывает, что
      // стадия сменилась (stageId вне категории игнорируется молча).
      const after = await call('crm.item.get', { entityTypeId: args.entityTypeId, id: p.itemId });
      await sleep(1000 / args.rps);
      const afterStage = String(after?.item?.stageId || '');
      if (afterStage !== args.doneStage) throw new Error(`стадия не переключилась: ожидали ${args.doneStage}, получили ${afterStage || '<пусто>'}`);
      updated += 1;
      appendState(args.stateFile, { itemId: p.itemId, reportId: p.reportId, outcome: 'updated', from: p.from, to: args.doneStage });
    } catch (error) {
      failed += 1;
      const message = String(error?.message || error);
      console.error(`[BUG-8709] #${p.itemId} (отчёт ${p.reportId}): ${message}`);
      appendState(args.stateFile, { itemId: p.itemId, reportId: p.reportId, outcome: 'failed', message });
    }
    if ((updated + skipped + failed) % 25 === 0) {
      process.stdout.write(`\r[BUG-8709] переведено ${updated}, пропущено ${skipped}, ошибок ${failed} из ${plan.length}   `);
    }
  }
  process.stdout.write('\n');
  console.log(`[BUG-8709] готово. переведено: ${updated}; пропущено: ${skipped}; ошибок: ${failed}. Журнал: ${args.stateFile}`);
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`[BUG-8709] прогон прерван: ${error?.message || error}`);
  process.exitCode = 1;
});
