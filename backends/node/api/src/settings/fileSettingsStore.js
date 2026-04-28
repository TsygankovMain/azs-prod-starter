import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { normalizeSettings } from './defaultSettings.js';

const DEFAULT_SETTINGS_FILE = './data/settings.json';

export const resolveSettingsFilePath = () => resolve(process.env.APP_SETTINGS_FILE || DEFAULT_SETTINGS_FILE);

export class FileSettingsStore {
  constructor(filePath = resolveSettingsFilePath()) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return normalizeSettings(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return normalizeSettings();
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Settings file contains invalid JSON: ${this.filePath}`);
      }

      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeSettings(settings);
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);

    return normalized;
  }
}

export const createFileSettingsStore = (filePath) => new FileSettingsStore(filePath);
