import express from 'express';
import { createFileSettingsStore } from './fileSettingsStore.js';
import { DEFAULT_SETTINGS, deepMerge, normalizeSettings, SettingsValidationError } from './defaultSettings.js';

const BITRIX_STORAGE_NOT_IMPLEMENTED = 'APP_SETTINGS_STORAGE=bitrix is not implemented yet. Direct Bitrix24 app.option storage will be added after install token persistence is available.';

const getStorageType = () => (process.env.APP_SETTINGS_STORAGE || 'file').toLowerCase();

const sendBitrixStorageNotImplemented = (res) => res.status(501).json({
  error: 'settings_storage_not_implemented',
  message: BITRIX_STORAGE_NOT_IMPLEMENTED
});

const handleSettingsError = (res, error) => {
  if (error instanceof SettingsValidationError) {
    return res.status(error.statusCode).json({
      error: 'invalid_settings',
      message: error.message,
      details: error.errors
    });
  }

  console.error('Settings API error', error);
  return res.status(500).json({
    error: 'settings_error',
    message: 'Unable to process settings request'
  });
};

export const createSettingsRouter = ({ store = createFileSettingsStore() } = {}) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    if (getStorageType() === 'bitrix') {
      return sendBitrixStorageNotImplemented(res);
    }

    if (getStorageType() !== 'file') {
      return res.status(400).json({
        error: 'unsupported_settings_storage',
        message: 'APP_SETTINGS_STORAGE must be file or bitrix'
      });
    }

    try {
      const settings = await store.read();
      return res.json({
        settings,
        defaults: DEFAULT_SETTINGS
      });
    } catch (error) {
      return handleSettingsError(res, error);
    }
  });

  router.put('/', async (req, res) => {
    if (getStorageType() === 'bitrix') {
      return sendBitrixStorageNotImplemented(res);
    }

    if (getStorageType() !== 'file') {
      return res.status(400).json({
        error: 'unsupported_settings_storage',
        message: 'APP_SETTINGS_STORAGE must be file or bitrix'
      });
    }

    try {
      const incoming = req.body?.settings;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return res.status(400).json({
          error: 'invalid_settings_payload',
          message: 'PUT /api/settings expects body { "settings": { ... } }'
        });
      }

      const currentSettings = await store.read();
      const nextSettings = normalizeSettings(deepMerge(currentSettings, incoming));
      const settings = await store.write(nextSettings);

      return res.json({ settings });
    } catch (error) {
      return handleSettingsError(res, error);
    }
  });

  return router;
};

export default createSettingsRouter;
