import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_CANDIDATES_FILE = './data/dispatch-candidates.json';

export const resolveCandidatesFile = () => resolve(process.env.APP_DISPATCH_CANDIDATES_FILE || DEFAULT_CANDIDATES_FILE);

export const readDispatchCandidates = async (filePath = resolveCandidatesFile()) => {
  try {
    const raw = await readFile(filePath, 'utf8');
    const payload = JSON.parse(raw);
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : payload;
    return Array.isArray(candidates) ? candidates : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    if (error instanceof SyntaxError) {
      throw new Error(`dispatch candidates file has invalid JSON: ${filePath}`);
    }
    throw error;
  }
};

export default readDispatchCandidates;

