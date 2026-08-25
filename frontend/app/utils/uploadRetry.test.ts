/**
 * Бережный режим загрузки (x1) не включался там, где он нужнее всего.
 *
 * На части АЗС реальная отдача канала — 10–20 кбит/с при том, что браузер
 * рапортует «4g, ~10 Мбит». Фото весит около 100 КБ, то есть уходит 45–80
 * секунд, а клиент обрывает запрос на 55-й (UPLOAD_TIMEOUT_MS). Две
 * параллельные загрузки делят и без того узкий канал, поэтому падают обе.
 *
 * Признак перегрузки искали только в ответе сервера. При обрыве по таймауту
 * ответа нет вовсе, поэтому проверка получала undefined, возвращала false —
 * и приложение продолжало грузить по два файла, снова упираясь в таймаут.
 * За неделю так оборвались 317 загрузок у 26 станций.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isRetryableUploadIssue } from './uploadRetry.ts'

test('обрыв по таймауту загрузки считается поводом для бережного режима', () => {
  const aborted = new Error('Загрузка фото прервана: сервер не ответил вовремя. Попробуйте ещё раз.')

  assert.equal(isRetryableUploadIssue({ error: aborted }), true)
})

test('обрыв соединения без ответа сервера тоже считается', () => {
  assert.equal(isRetryableUploadIssue({ error: new Error('Failed to fetch') }), true)
  assert.equal(isRetryableUploadIssue({ error: new DOMException('The user aborted a request.', 'AbortError') }), true)
})

test('лимиты Битрикса по-прежнему распознаются по ответу сервера', () => {
  assert.equal(isRetryableUploadIssue({ errorCode: 'bitrix_retryable' }), true)
  assert.equal(isRetryableUploadIssue({ message: 'OPERATION_TIME_LIMIT' }), true)
  assert.equal(isRetryableUploadIssue({ message: 'HTTP 429 too many requests' }), true)
})

test('отказ по существу не переводит загрузку в бережный режим', () => {
  assert.equal(isRetryableUploadIssue({ errorCode: 'forbidden_user', message: 'Доступ запрещён' }), false)
  assert.equal(isRetryableUploadIssue({ error: new Error('Файл повреждён') }), false)
  assert.equal(isRetryableUploadIssue({}), false)
})
