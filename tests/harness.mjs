// Loads api/adspend.js outside Vercel.
//
// Two imports do not resolve here. @vercel/kv is not installed locally, and
// ./adcampaigns.js is relative to api/ rather than to this directory. Both are
// rewritten in a copy written beside this file; the copies are gitignored.
//
// Pass a kv stub when the test exercises anything that stores. Without one, kv
// is null and touching it throws, which is the honest outcome for a suite that
// should be testing pure functions.
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

// An in-memory stand-in for @vercel/kv. Only get and set are used.
export function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null; },
    async set(k, v) { store.set(k, JSON.parse(JSON.stringify(v))); return 'OK'; }
  };
}

export async function loadAdspend(tag, kv) {
  const src = fs.readFileSync(path.join(here, '..', 'api', 'adspend.js'), 'utf8')
    // The stub is reached through globalThis so the test can hand one in.
    .replace(/^import \{ kv \} from '@vercel\/kv';$/m,
             'const kv = globalThis.__TEST_KV__ || null;')
    // The census sync is only called by the cron handler, which no suite drives.
    .replace(/^import \{ acRunSync \} from '\.\/adcampaigns\.js';$/m,
             'const acRunSync = async () => { throw new Error("acRunSync is not stubbed"); };');

  const f = path.join(here, `.${tag}_testable.mjs`);
  fs.writeFileSync(f, src);
  globalThis.__TEST_KV__ = kv || null;
  const M = await import(pathToFileURL(f).href);
  return { M, cleanup: () => { try { fs.unlinkSync(f); } catch { /* already gone */ } } };
}
