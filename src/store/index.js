import { createPostgrest } from './postgrest.js';
import { createMemoryStore } from './memory.js';

export { createMemoryStore, createPostgrest };

/** Full-access store (server secret key). Null when the database is not configured. */
export function createStore(config, opts = {}) {
  if (!config.has.db) return null;
  return createPostgrest({ url: config.supabaseUrl, key: config.supabaseSecret, ...opts });
}

/**
 * Public-entry store: uses only the publishable key and can call just the two narrow RPCs
 * (join_waitlist, log_event). Everything else is blocked by row level security.
 */
export function createPublicStore(config, opts = {}) {
  if (!config.has.anon) return null;
  const pg = createPostgrest({ url: config.supabaseUrl, key: config.supabaseAnon, ...opts });
  return { kind: 'public', rpc: pg.rpc.bind(pg) };
}
