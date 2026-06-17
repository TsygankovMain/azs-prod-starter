/**
 * reasonButtonPress.test.js — REASON-BTN-TEXT.
 *
 * Кнопка причины показывает человеческий текст («Не успеваю — указать причину»),
 * а не техническое «/reason 871». Бот распознаёт нажатие по тексту-маркеру и
 * сам находит активный отчёт пользователя.
 *
 * isReasonButtonPress(text) — точное совпадение с известными подписями кнопки
 * (trim + case-insensitive), НЕ срабатывает на произвольной причине.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isReasonButtonPress,
  REASON_BUTTON_LABEL_DISPATCH,
  REASON_BUTTON_LABEL_TIMEOUT
} from '../src/notifications/botCommandHandler.js';

test('isReasonButtonPress: распознаёт подпись кнопки рассылки', () => {
  assert.equal(isReasonButtonPress(REASON_BUTTON_LABEL_DISPATCH), true);
});

test('isReasonButtonPress: распознаёт подпись кнопки просрочки', () => {
  assert.equal(isReasonButtonPress(REASON_BUTTON_LABEL_TIMEOUT), true);
});

test('isReasonButtonPress: trim + регистронезависимо', () => {
  assert.equal(isReasonButtonPress('  не успеваю — указать причину  '), true);
  assert.equal(isReasonButtonPress('УКАЗАТЬ ПРИЧИНУ'), true);
});

test('isReasonButtonPress: НЕ срабатывает на произвольной причине', () => {
  assert.equal(isReasonButtonPress('Не успел, на АЗС была авария'), false);
  assert.equal(isReasonButtonPress('сломалась касса'), false);
});

test('isReasonButtonPress: пустой/мусор → false', () => {
  assert.equal(isReasonButtonPress(''), false);
  assert.equal(isReasonButtonPress(null), false);
  assert.equal(isReasonButtonPress('/reason 5'), false, '/reason N — отдельный путь, не маркер кнопки');
});

test('подписи кнопок заданы человеческим текстом (без /reason)', () => {
  assert.ok(!REASON_BUTTON_LABEL_DISPATCH.includes('/reason'));
  assert.ok(!REASON_BUTTON_LABEL_TIMEOUT.includes('/reason'));
  assert.ok(REASON_BUTTON_LABEL_DISPATCH.toLowerCase().includes('причин'));
});
