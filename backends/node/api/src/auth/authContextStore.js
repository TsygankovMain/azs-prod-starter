import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_AUTH_CONTEXT_FILE = './data/auth-context.json';

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const normalizeAuthContext = (input = {}) => {
  const source = isPlainObject(input) ? input : {};
  return {
    authId: String(source.authId || '').trim(),
    refreshToken: String(source.refreshToken || '').trim(),
    domain: String(source.domain || '').trim(),
    updatedAt: source.updatedAt || new Date().toISOString()
  };
};

export const resolveAuthContextFilePath = () => resolve(
  process.env.APP_AUTH_CONTEXT_FILE || DEFAULT_AUTH_CONTEXT_FILE
);

export class AuthContextStore {
  constructor(filePath = resolveAuthContextFilePath()) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const normalized = normalizeAuthContext(parsed);
      return normalized.authId || normalized.refreshToken || normalized.domain
        ? normalized
        : null;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Auth context file contains invalid JSON: ${this.filePath}`);
      }
      throw error;
    }
  }

  async write(nextContext = {}) {
    const previous = (await this.read()) || {};
    const merged = normalizeAuthContext({
      ...previous,
      ...nextContext,
      updatedAt: new Date().toISOString()
    });

    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);

    return merged;
  }
}

export const createAuthContextStore = (filePath) => new AuthContextStore(filePath);

