/** Coerce an untrusted JSON body into a list.
 *
 * `(await r.json()) as Thing[]` is a cast, not a check: a 200 carrying anything
 * but a JSON array — an error envelope like `{"detail": …}`, a proxy's own
 * reply, another service answering on the backend's port — was stored as the
 * list and killed the first component to call `.find`/`.map` on it. Every
 * list-shaped response goes through here so a malformed body degrades to the
 * empty list the callers already handle when offline.
 *
 * Deliberately shallow: it guarantees the container, not the elements. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
