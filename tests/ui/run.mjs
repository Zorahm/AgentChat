/** Compile and run the UI test suites.
 *
 * The UI ships no test runner (an offline-built app doesn't need another dev
 * dependency), so the suites are TypeScript compiled with the repo's own tsc
 * and executed by Node:
 *
 *     node tests/ui/run.mjs
 *
 * Sources are compiled from their real locations — the suites import
 * `ui/src/...` directly, so they can never drift from the shipped code. The
 * one exception is `persistence.ts`, replaced by a stub after compilation
 * (see tests/ui/stubs/persistence.js).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const buildDir = join(here, ".build");
const tsc = join(repoRoot, "ui", "node_modules", "typescript", "bin", "tsc");

const SUITES = ["branch_tree", "sse_stream", "agent_greeting"];

if (!existsSync(tsc)) {
  console.error(
    `TypeScript not found at ${tsc}\nRun: npm install --prefix ui`,
  );
  process.exit(1);
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const tscArgs = [
  tsc,
  "--rootDir", repoRoot,
  "--outDir", buildDir,
  "--module", "commonjs",
  "--moduleResolution", "node",
  "--target", "es2022",
  "--lib", "es2022,dom",
  "--strict",
  "--noUncheckedIndexedAccess",
  "--skipLibCheck",
  "--esModuleInterop",
  "--resolveJsonModule",
  join(here, "src", "node.d.ts"),
  ...SUITES.map((s) => join(here, "src", `${s}.ts`)),
];

const compiled = spawnSync(process.execPath, tscArgs, { stdio: "inherit" });
if (compiled.status !== 0) {
  console.error("\nCompilation failed.");
  process.exit(compiled.status ?? 1);
}

// Swap in the persistence stub (see the header comment).
const stubTarget = join(buildDir, "ui", "src", "hooks", "useChats", "persistence.js");
if (existsSync(stubTarget)) {
  copyFileSync(join(here, "stubs", "persistence.js"), stubTarget);
}

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n──── ${suite} ${"─".repeat(Math.max(0, 60 - suite.length))}`);
  const run = spawnSync(
    process.execPath,
    [join(buildDir, "tests", "ui", "src", `${suite}.js`)],
    { stdio: "inherit" },
  );
  if (run.status !== 0) failed += 1;
}

console.log(
  failed === 0
    ? `\nAll ${SUITES.length} UI suites passed.`
    : `\n${failed} of ${SUITES.length} UI suites FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
