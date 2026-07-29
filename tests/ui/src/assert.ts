/** Minimal assertion + reporting helpers for the Node-run UI suites.
 *
 * The UI has no test runner (adding one would mean a new dependency for an
 * offline-built app), so these suites are plain TypeScript compiled with the
 * repo's own tsc and executed by Node. This module is the whole framework:
 * register checks, print a report, set the exit code. */

interface Failure {
  readonly test: string;
  readonly message: string;
}

const failures: Failure[] = [];
let passed = 0;
let current = "";

/** Run one test. Failures are collected, never thrown — a broken assertion
 *  must not hide the results of the checks that follow it. */
export function test(name: string, fn: () => void): void {
  current = name;
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ test: name, message });
    console.log(`  FAIL ${name}\n       ${message}`);
  } finally {
    current = "";
  }
}

/** Async variant of `test` — the SSE suite has to await stream teardown. */
export async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  current = name;
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ test: name, message });
    console.log(`  FAIL ${name}\n       ${message}`);
  } finally {
    current = "";
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Assert `actual` is within `±tolerance` (a ratio, e.g. 0.1 = 10%) of
 *  `expected`. Used for size/growth checks, where exact bytes are brittle but
 *  an order-of-magnitude regression is exactly what we want to catch. */
export function assertNear(actual: number, expected: number, tolerance: number, what: string): void {
  const drift = Math.abs(actual - expected) / (expected === 0 ? 1 : expected);
  if (drift > tolerance) {
    throw new Error(
      `${what}: expected ~${expected} (±${Math.round(tolerance * 100)}%), got ${actual} (off by ${Math.round(drift * 100)}%)`,
    );
  }
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

/** Print the summary and set the process exit code. Called by each suite's
 *  entry point; a non-zero code is what makes the runner fail. */
export function report(suite: string): void {
  console.log(
    `\n${suite}: ${passed} passed, ${failures.length} failed` +
      (current ? ` (interrupted during "${current}")` : ""),
  );
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.test}: ${f.message}`);
    process.exitCode = 1;
  }
}
