import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_AUTH_CONTEXT_FILE = './data/auth-context.json';

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const normalizeDomain = (value) => String(value || '').trim().toLowerCase();

const normalizeMemberId = (value) => String(value || '').trim();

const parseUserId = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

export const buildAuthContextKey = ({ memberId, domain, userId }) => {
  const normalizedMemberId = normalizeMemberId(memberId);
  const normalizedDomain = normalizeDomain(domain);
  const normalizedUserId = parseUserId(userId);
  if (!normalizedMemberId || !normalizedDomain || !normalizedUserId) {
    return '';
  }
  return `${normalizedMemberId}:${normalizedDomain}:${normalizedUserId}`;
};

const normalizeContextRecord = (input = {}) => {
  const source = isPlainObject(input) ? input : {};
  return {
    memberId: normalizeMemberId(source.memberId),
    domain: normalizeDomain(source.domain),
    userId: parseUserId(source.userId),
    authId: String(source.authId || '').trim(),
    refreshToken: String(source.refreshToken || '').trim(),
    appSid: String(source.appSid || '').trim(),
    isAdmin: Boolean(source.isAdmin),
    verifiedAt: String(source.verifiedAt || '').trim(),
    // ISO timestamp of when the current refreshToken was issued by Bitrix.
    // Used by tokenRefreshScheduler to warn at ~23 days and force-refresh
    // at ~29 days (Bitrix refresh_token TTL is ~30 days).
    refreshTokenIssuedAt: String(source.refreshTokenIssuedAt || '').trim(),
    updatedAt: String(source.updatedAt || '').trim() || new Date().toISOString()
  };
};

const normalizeStoreState = (input = {}) => {
  const source = isPlainObject(input) ? input : {};
  const contextsRaw = isPlainObject(source.contexts) ? source.contexts : {};
  const contexts = {};

  for (const [key, value] of Object.entries(contextsRaw)) {
    const normalizedValue = normalizeContextRecord(value);
    const normalizedKey = buildAuthContextKey(normalizedValue);
    if (!normalizedKey) {
      continue;
    }
    contexts[normalizedKey] = normalizedValue;
  }

  const lastAdminKey = String(source.lastAdminKey || '').trim();
  return {
    version: 1,
    contexts,
    lastAdminKey: contexts[lastAdminKey] ? lastAdminKey : '',
    updatedAt: String(source.updatedAt || '').trim() || new Date().toISOString()
  };
};

export const resolveAuthContextFilePath = () => resolve(
  process.env.APP_AUTH_CONTEXT_FILE || DEFAULT_AUTH_CONTEXT_FILE
);

export class AuthContextStore {
  constructor(filePath = resolveAuthContextFilePath()) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async readState() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeStoreState(parsed);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return normalizeStoreState();
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Auth context file contains invalid JSON: ${this.filePath}`);
      }
      throw error;
    }
  }

  async writeState(state) {
    const normalized = normalizeStoreState(state);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
    return normalized;
  }

  async mutate(mutator) {
    const run = async () => {
      const current = await this.readState();
      const next = await mutator(current);
      return this.writeState(next);
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  async upsertContext(contextInput = {}) {
    // Merge the RAW input (only the keys actually supplied) over the existing
    // record. Pre-normalizing the input here would fill every field with
    // empty-string/false defaults, so a partial upsert (e.g. a fresh access
    // token without a new refreshToken) would wipe previously stored values
    // such as refreshToken / isAdmin instead of keeping them. Normalization
    // happens once, after the merge below.
    const source = isPlainObject(contextInput) ? contextInput : {};
    const key = buildAuthContextKey(source);
    if (!key) {
      throw new Error('memberId, domain and userId are required for auth context upsert');
    }

    const state = await this.mutate((current) => {
      const next = normalizeStoreState(current);
      const previous = next.contexts[key] || {};
      const merged = normalizeContextRecord({
        ...previous,
        ...source,
        updatedAt: new Date().toISOString()
      });
      next.contexts[key] = merged;
      if (merged.isAdmin) {
        next.lastAdminKey = key;
      } else if (!next.lastAdminKey) {
        next.lastAdminKey = key;
      }
      next.updatedAt = new Date().toISOString();
      return next;
    });

    return {
      key,
      context: state.contexts[key]
    };
  }

  async getContextByKey(keyValue) {
    const key = String(keyValue || '').trim();
    if (!key) {
      return null;
    }
    const state = await this.readState();
    return state.contexts[key] || null;
  }

  async getContext({ memberId, domain, userId }) {
    const key = buildAuthContextKey({ memberId, domain, userId });
    if (!key) {
      return null;
    }
    return this.getContextByKey(key);
  }

  async getLastAdminContext() {
    const state = await this.readState();
    // Strict admin-only resolution. Previously this method silently fell back
    // to "any context" which let the dispatch scheduler run under a regular
    // user token and hit insufficient_scope on REST calls. We now require
    // an explicit isAdmin: true context — caller decides what to do on null.
    if (state.lastAdminKey && state.contexts[state.lastAdminKey]?.isAdmin) {
      return {
        key: state.lastAdminKey,
        context: state.contexts[state.lastAdminKey]
      };
    }
    const adminEntry = Object.entries(state.contexts)
      .find(([, value]) => Boolean(value?.isAdmin));
    if (!adminEntry) {
      return null;
    }
    const [key, context] = adminEntry;
    return { key, context };
  }

  // Waits for all pending serialized writes to complete.
  // Call this during graceful shutdown to ensure no in-flight write is lost.
  async flush() {
    await this.writeChain;
  }

  // Returns every stored context. Used by tokenRefreshScheduler to walk all
  // user records and pre-emptively refresh the ones nearing 30-day expiry.
  async listContexts() {
    const state = await this.readState();
    return Object.entries(state.contexts).map(([key, context]) => ({
      key,
      context
    }));
  }
}

export const createAuthContextStore = (filePath) => new AuthContextStore(filePath);

