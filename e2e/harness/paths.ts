import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(E2E_DIR, '..');
export const STATE_FILE = path.join(E2E_DIR, '.state', 'stack.json');
export const LOG_DIR = path.join(E2E_DIR, '.state', 'logs');
