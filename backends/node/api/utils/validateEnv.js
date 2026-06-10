const REQUIRED_ALWAYS = ['JWT_SECRET'];

export function validateRequiredEnv(env = process.env) {
  const missing = REQUIRED_ALWAYS.filter(
    (name) => !env[name] || !String(env[name]).trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Refusing to start: auth would silently fail for all users.'
    );
  }
}
