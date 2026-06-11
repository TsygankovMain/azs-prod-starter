import { readFileSync } from 'node:fs';

/**
 * Resolves the pg `ssl` option from environment variables.
 *
 * DB_SSL values:
 *   'true' | 'require'  → ssl: { rejectUnauthorized: false }   (Timeweb managed PG, self-signed)
 *   'verify-full'       → ssl: { rejectUnauthorized: true, ca: <PEM> }  (trusted CA)
 *   not set | 'false'   → undefined  (dev-compatible, no TLS)
 *
 * CA source for verify-full (first defined wins):
 *   DB_SSL_CA_CONTENT   PEM string injected directly via env
 *   DB_SSL_CA           path to a PEM file on disk
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ rejectUnauthorized: boolean, ca?: string } | undefined}
 */
export function resolvePgSslConfig(env = process.env) {
  const rawMode = String(env.DB_SSL || '').trim().toLowerCase();

  if (!rawMode || rawMode === 'false') {
    return undefined;
  }

  if (rawMode === 'true' || rawMode === 'require') {
    return { rejectUnauthorized: false };
  }

  if (rawMode === 'verify-full') {
    const caContent = String(env.DB_SSL_CA_CONTENT || '').trim();
    if (caContent) {
      return { rejectUnauthorized: true, ca: caContent };
    }

    const caPath = String(env.DB_SSL_CA || '').trim();
    if (caPath) {
      return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
    }

    throw new Error(
      'DB_SSL=verify-full requires a CA certificate: ' +
      'set DB_SSL_CA_CONTENT (PEM string) or DB_SSL_CA (path to PEM file).'
    );
  }

  throw new Error(
    `Unknown DB_SSL value: "${rawMode}". ` +
    'Accepted values: true, require, verify-full, false (or unset).'
  );
}
