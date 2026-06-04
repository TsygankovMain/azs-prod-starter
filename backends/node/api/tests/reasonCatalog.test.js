import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasonCatalog, DEFAULT_REASONS_SEED } from '../src/reports/reasonCatalog.js';

const sampleReasons = [
  { code: 'fuel_truck', label: 'Приёмка топлива / бензовоз' },
  { code: 'queue',      label: 'Очередь / много гостей' },
  { code: 'other',      label: 'Другое (требует текст)' }
];

test('DEFAULT_REASONS_SEED содержит other', () => {
  const other = DEFAULT_REASONS_SEED.find(r => r.code === 'other');
  assert.ok(other, 'other должен быть в seed');
});

test('codeToLabel возвращает label по коду из настроек', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.codeToLabel('queue'), 'Очередь / много гостей');
});

test('codeToLabel возвращает undefined для неизвестного кода', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.codeToLabel('unknown'), undefined);
});

test('labelToCode восстанавливает code по label (round-trip)', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.labelToCode('Очередь / много гостей'), 'queue');
});

test('encodeValue: пресет → label', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.encodeValue('queue', null), 'Очередь / много гостей');
});

test('encodeValue: other + text → "Другое: <text>"', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.encodeValue('other', 'кран сломался'), 'Другое: кран сломался');
});

test('decodeValue: label → { code, text: null }', () => {
  const cat = createReasonCatalog(sampleReasons);
  const result = cat.decodeValue('Очередь / много гостей');
  assert.equal(result.code, 'queue');
  assert.equal(result.text, null);
});

test('decodeValue: "Другое: <text>" → { code: other, text }', () => {
  const cat = createReasonCatalog(sampleReasons);
  const result = cat.decodeValue('Другое: кран сломался');
  assert.equal(result.code, 'other');
  assert.equal(result.text, 'кран сломался');
});

test('decodeValue: нераспознанное → { code: other, text: original }', () => {
  const cat = createReasonCatalog(sampleReasons);
  const result = cat.decodeValue('неизвестная причина');
  assert.equal(result.code, 'other');
  assert.equal(result.text, 'неизвестная причина');
});

test('isOther возвращает true только для кода other', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.isOther('other'), true);
  assert.equal(cat.isOther('queue'), false);
});

test('isValidCode принимает коды из настроек', () => {
  const cat = createReasonCatalog(sampleReasons);
  assert.equal(cat.isValidCode('queue'), true);
  assert.equal(cat.isValidCode('unknown_code'), false);
});
