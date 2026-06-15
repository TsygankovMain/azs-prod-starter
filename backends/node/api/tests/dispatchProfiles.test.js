/**
 * S8-A1: Тесты модели профилей рассылки в настройках + resolveProfileForAzs
 *
 * TDD RED → GREEN:
 *  1. dispatchProfiles в DEFAULT_SETTINGS, mergeSettings, validateSettings
 *  2. resolveProfileForAzs в dispatchProfileResolver.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  validateSettings
} from '../src/settings/defaultSettings.js';
import { resolveProfileForAzs } from '../src/dispatch/dispatchProfileResolver.js';

// ─── DEFAULT_SETTINGS ─────────────────────────────────────────────────────────

test('DEFAULT_SETTINGS.dispatchProfiles is an empty array', () => {
  assert.ok(Array.isArray(DEFAULT_SETTINGS.dispatchProfiles));
  assert.equal(DEFAULT_SETTINGS.dispatchProfiles.length, 0);
});

// ─── mergeSettings ─────────────────────────────────────────────────────────────

test('mergeSettings defaults dispatchProfiles to empty array when absent', () => {
  const merged = mergeSettings({});
  assert.ok(Array.isArray(merged.dispatchProfiles));
  assert.equal(merged.dispatchProfiles.length, 0);
});

test('mergeSettings replaces dispatchProfiles with saved value', () => {
  const profile = {
    id: 'p1',
    name: 'Тест',
    azsIds: ['42'],
    mode: 'A',
    config: { slots: ['09:00'], jitterMinutes: 0 }
  };
  const merged = mergeSettings({ dispatchProfiles: [profile] });
  assert.equal(merged.dispatchProfiles.length, 1);
  assert.equal(merged.dispatchProfiles[0].id, 'p1');
});

// ─── validateSettings — пустой массив (обратная совместимость) ─────────────────

test('validateSettings accepts empty dispatchProfiles array (backward compat)', () => {
  const normalized = validateSettings(mergeSettings({ dispatchProfiles: [] }));
  assert.ok(Array.isArray(normalized.dispatchProfiles));
  assert.equal(normalized.dispatchProfiles.length, 0);
});

test('normalizeSettings returns empty dispatchProfiles when field absent', () => {
  const normalized = normalizeSettings({});
  assert.ok(Array.isArray(normalized.dispatchProfiles));
  assert.equal(normalized.dispatchProfiles.length, 0);
});

// ─── validateSettings — режим A (валидный) ──────────────────────────────────

test('validateSettings accepts valid mode-A profile', () => {
  const profiles = [{
    id: 'city',
    name: 'Городские',
    azsIds: ['7', '88'],
    mode: 'A',
    config: { slots: ['09:00', '17:00'], jitterMinutes: 10 }
  }];
  const normalized = validateSettings(mergeSettings({ dispatchProfiles: profiles }));
  assert.equal(normalized.dispatchProfiles.length, 1);
  assert.equal(normalized.dispatchProfiles[0].mode, 'A');
  assert.deepEqual(normalized.dispatchProfiles[0].config.slots, ['09:00', '17:00']);
  assert.equal(normalized.dispatchProfiles[0].config.jitterMinutes, 10);
});

test('validateSettings accepts mode-A profile with jitterMinutes 0', () => {
  const profiles = [{
    id: 'p-zero-jitter',
    name: 'Без джиттера',
    azsIds: ['1'],
    mode: 'A',
    config: { slots: ['12:00'], jitterMinutes: 0 }
  }];
  assert.doesNotThrow(() => validateSettings(mergeSettings({ dispatchProfiles: profiles })));
});

// ─── validateSettings — режим B (валидный) ──────────────────────────────────

test('validateSettings accepts valid mode-B profile', () => {
  const profiles = [{
    id: 'highway',
    name: 'Трассовые',
    azsIds: ['42', '117'],
    mode: 'B',
    config: {
      windows: [
        { from: '06:00', to: '10:00' },
        { from: '13:00', to: '16:00' }
      ],
      escalateUntilDone: true
    }
  }];
  const normalized = validateSettings(mergeSettings({ dispatchProfiles: profiles }));
  assert.equal(normalized.dispatchProfiles.length, 1);
  assert.equal(normalized.dispatchProfiles[0].mode, 'B');
  assert.equal(normalized.dispatchProfiles[0].config.windows.length, 2);
  assert.equal(normalized.dispatchProfiles[0].config.escalateUntilDone, true);
});

test('validateSettings accepts mode-B profile with escalateUntilDone false', () => {
  const profiles = [{
    id: 'p-no-escalate',
    name: 'Без эскалации',
    azsIds: ['5'],
    mode: 'B',
    config: {
      windows: [{ from: '08:00', to: '12:00' }],
      escalateUntilDone: false
    }
  }];
  assert.doesNotThrow(() => validateSettings(mergeSettings({ dispatchProfiles: profiles })));
});

test('validateSettings accepts mode-B profile without escalateUntilDone (optional)', () => {
  const profiles = [{
    id: 'p-no-esc-field',
    name: 'Без поля эскалации',
    azsIds: ['6'],
    mode: 'B',
    config: {
      windows: [{ from: '09:00', to: '11:00' }]
    }
  }];
  assert.doesNotThrow(() => validateSettings(mergeSettings({ dispatchProfiles: profiles })));
});

// ─── validateSettings — невалидный mode ──────────────────────────────────────

test('validateSettings rejects profile with invalid mode', () => {
  const profiles = [{
    id: 'bad-mode',
    name: 'Некорректный',
    azsIds: ['1'],
    mode: 'C',
    config: { slots: ['09:00'], jitterMinutes: 0 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.mode must be 'A' or 'B'/
  );
});

test('validateSettings rejects profile with missing mode', () => {
  const profiles = [{
    id: 'no-mode',
    name: 'Без режима',
    azsIds: ['1'],
    config: { slots: ['09:00'], jitterMinutes: 0 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.mode must be 'A' or 'B'/
  );
});

// ─── validateSettings — невалидный режим A ───────────────────────────────────

test('validateSettings rejects mode-A profile with empty slots', () => {
  const profiles = [{
    id: 'a-no-slots',
    name: 'Без слотов',
    azsIds: ['1'],
    mode: 'A',
    config: { slots: [], jitterMinutes: 5 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.slots must be a non-empty array/
  );
});

test('validateSettings rejects mode-A profile with invalid HH:mm slot', () => {
  const profiles = [{
    id: 'a-bad-slot',
    name: 'Плохой слот',
    azsIds: ['1'],
    mode: 'A',
    config: { slots: ['9:00', 'bad'], jitterMinutes: 5 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.slots contains invalid values/
  );
});

test('validateSettings rejects mode-A profile with negative jitterMinutes', () => {
  const profiles = [{
    id: 'a-neg-jitter',
    name: 'Негативный джиттер',
    azsIds: ['1'],
    mode: 'A',
    config: { slots: ['09:00'], jitterMinutes: -1 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.jitterMinutes must be >= 0/
  );
});

// ─── validateSettings — невалидный режим B ───────────────────────────────────

test('validateSettings rejects mode-B profile with empty windows', () => {
  const profiles = [{
    id: 'b-no-windows',
    name: 'Без окон',
    azsIds: ['1'],
    mode: 'B',
    config: { windows: [], escalateUntilDone: true }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.windows must be a non-empty array/
  );
});

test('validateSettings rejects mode-B profile with window from >= to', () => {
  const profiles = [{
    id: 'b-bad-window',
    name: 'Плохое окно',
    azsIds: ['1'],
    mode: 'B',
    config: {
      windows: [{ from: '16:00', to: '10:00' }],
      escalateUntilDone: true
    }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.windows\[0\].*from.*must be earlier than.*to/
  );
});

test('validateSettings rejects mode-B profile with window from equals to', () => {
  const profiles = [{
    id: 'b-equal-window',
    name: 'Равные границы',
    azsIds: ['1'],
    mode: 'B',
    config: {
      windows: [{ from: '10:00', to: '10:00' }],
      escalateUntilDone: true
    }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.windows\[0\].*from.*must be earlier than.*to/
  );
});

test('validateSettings rejects mode-B profile with malformed window time', () => {
  const profiles = [{
    id: 'b-malformed',
    name: 'Некорректное время',
    azsIds: ['1'],
    mode: 'B',
    config: {
      windows: [{ from: '8:00', to: '10:00' }],
      escalateUntilDone: true
    }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.config\.windows\[0\].*must match HH:mm/
  );
});

// ─── validateSettings — невалидный azsIds ────────────────────────────────────

test('validateSettings rejects profile with non-array azsIds', () => {
  const profiles = [{
    id: 'bad-azs',
    name: 'Плохие АЗС',
    azsIds: '42',
    mode: 'A',
    config: { slots: ['09:00'], jitterMinutes: 0 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.azsIds must be an array of strings/
  );
});

// ─── validateSettings — дублирующие azsIds в нескольких профилях ─────────────

test('validateSettings rejects dispatchProfiles where same azsId appears in two profiles', () => {
  const profiles = [
    {
      id: 'p1',
      name: 'Профиль 1',
      azsIds: ['42', '100'],
      mode: 'A',
      config: { slots: ['09:00'], jitterMinutes: 0 }
    },
    {
      id: 'p2',
      name: 'Профиль 2',
      azsIds: ['42', '200'],
      mode: 'A',
      config: { slots: ['17:00'], jitterMinutes: 5 }
    }
  ];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles.*azsId '42' appears in multiple profiles/
  );
});

// ─── validateSettings — обязательные поля профиля ────────────────────────────

test('validateSettings rejects profile with missing id', () => {
  const profiles = [{
    name: 'Без ID',
    azsIds: ['1'],
    mode: 'A',
    config: { slots: ['09:00'], jitterMinutes: 0 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.id must be a non-empty string/
  );
});

test('validateSettings rejects profile with missing name', () => {
  const profiles = [{
    id: 'no-name',
    azsIds: ['1'],
    mode: 'A',
    config: { slots: ['09:00'], jitterMinutes: 0 }
  }];
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: profiles })),
    /dispatchProfiles\[0\]\.name must be a non-empty string/
  );
});

test('validateSettings rejects dispatchProfiles that is not an array', () => {
  assert.throws(
    () => validateSettings(mergeSettings({ dispatchProfiles: 'bad' })),
    /dispatchProfiles must be an array/
  );
});

// ─── resolveProfileForAzs — базовые сценарии ─────────────────────────────────

const makeSettingsWithProfiles = (profiles) =>
  normalizeSettings({ dispatchProfiles: profiles });

test('resolveProfileForAzs returns null when dispatchProfiles is empty', () => {
  const settings = makeSettingsWithProfiles([]);
  assert.equal(resolveProfileForAzs('42', settings), null);
});

test('resolveProfileForAzs returns null when azsId not in any profile', () => {
  const settings = makeSettingsWithProfiles([{
    id: 'p1',
    name: 'Профиль 1',
    azsIds: ['100', '200'],
    mode: 'A',
    config: { slots: ['09:00'], jitterMinutes: 0 }
  }]);
  assert.equal(resolveProfileForAzs('42', settings), null);
});

test('resolveProfileForAzs returns the matching profile for an azsId', () => {
  const settings = makeSettingsWithProfiles([{
    id: 'city',
    name: 'Городские',
    azsIds: ['7', '88'],
    mode: 'A',
    config: { slots: ['09:00', '17:00'], jitterMinutes: 10 }
  }]);
  const profile = resolveProfileForAzs('88', settings);
  assert.ok(profile !== null);
  assert.equal(profile.id, 'city');
});

test('resolveProfileForAzs returns the first matching profile when azsId appears in multiple (conflict)', () => {
  const profiles = [
    {
      id: 'first',
      name: 'Первый',
      azsIds: ['42'],
      mode: 'A',
      config: { slots: ['09:00'], jitterMinutes: 0 }
    },
    {
      id: 'second',
      name: 'Второй',
      azsIds: ['42'],
      mode: 'A',
      config: { slots: ['17:00'], jitterMinutes: 5 }
    }
  ];
  // Используем validateSettings с пропуском дубликатов — тест резолвера отдельный
  // Здесь передаём напрямую, минуя validateSettings (тест резолвера как чистой функции)
  const fakeSettings = { dispatchProfiles: profiles };
  const profile = resolveProfileForAzs('42', fakeSettings);
  assert.ok(profile !== null);
  assert.equal(profile.id, 'first');
});

test('resolveProfileForAzs returns null when settings has no dispatchProfiles field', () => {
  const result = resolveProfileForAzs('42', {});
  assert.equal(result, null);
});

test('resolveProfileForAzs correctly matches azsId among multiple profiles', () => {
  const settings = makeSettingsWithProfiles([
    {
      id: 'highway',
      name: 'Трассовые',
      azsIds: ['42', '117'],
      mode: 'B',
      config: {
        windows: [{ from: '06:00', to: '10:00' }],
        escalateUntilDone: true
      }
    },
    {
      id: 'city',
      name: 'Городские',
      azsIds: ['7', '88'],
      mode: 'A',
      config: { slots: ['09:00'], jitterMinutes: 5 }
    }
  ]);

  // АЗС из первого профиля
  const highway = resolveProfileForAzs('117', settings);
  assert.equal(highway?.id, 'highway');

  // АЗС из второго профиля
  const city = resolveProfileForAzs('7', settings);
  assert.equal(city?.id, 'city');

  // АЗС не в профилях
  const none = resolveProfileForAzs('999', settings);
  assert.equal(none, null);
});
