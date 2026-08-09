/** Namespaces localStorage keys that hold *backend-owned ids*.
 *
 * Chats live in the backend's SQLite, but a few purely local lists key off
 * their ids — pinned chats, sidebar order. Point the app at a second backend
 * (a VDS, a paired PC) and those lists would be interpreted against a set of
 * ids that never existed there: chats pinned on one host, ordered on another.
 *
 * So keys of that kind get a suffix derived from the configured backend, and
 * the local backend keeps the bare key it has always used — no migration, no
 * lost pins for existing installs.
 *
 * NOT for client preferences (zoom, avatar, language) — those are properties of
 * the device and should follow the user across backends. And explicitly not for
 * the localStorage→SQLite migration flag: scoping that one would re-drain the
 * legacy chat blob into every backend the user ever connects to.
 */

import { getBackendOverride } from "./apiBase";

/** Short, stable, filename-safe digest of the backend URL. Collisions only cost
 *  a shared pin list between two hosts, so 32 bits of FNV-1a is plenty. */
function digest(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** `base` for the local backend, `base@<digest>` for any configured remote. */
export function scopedKey(base: string): string {
  const override = getBackendOverride();
  if (!override) return base;
  return `${base}@${digest(override)}`;
}
