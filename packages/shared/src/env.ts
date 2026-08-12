import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Locate and load the workspace-root `.env` exactly once, whatever the CWD.
 *
 * Entrypoints used to open with `import 'dotenv/config'`, which resolves `.env`
 * against `process.cwd()`. That works when a script is launched from the repo
 * root and silently loads nothing otherwise: `pnpm dev:bot` runs `tsx` with a
 * CWD of `apps/bot/`, so it found no file and died at startup reporting every
 * variable as "Required".
 *
 * The root is found by walking up from this module rather than from the CWD, so
 * the result no longer depends on where the process was started.
 */

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

function findWorkspaceRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let rootCache: string | undefined;
let rootResolved = false;

/**
 * Absolute path of the workspace root, or `undefined` when running outside a
 * checkout (a built image). Use it to anchor repo-relative defaults such as
 * `data/ngsl.csv`, which must not move with the CWD.
 */
export function workspaceRoot(): string | undefined {
  if (!rootResolved) {
    rootResolved = true;
    rootCache = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  }
  return rootCache;
}

let loaded = false;

/**
 * Idempotent, and never throws. Variables already present in the real
 * environment win — dotenv does not override them — so the container runtime's
 * `env_file` and CI secrets keep precedence over any `.env` on disk.
 */
export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  // A built image has no workspace root and no `.env`; the environment is
  // injected by the runtime there, so finding nothing is a normal outcome.
  const root = workspaceRoot();
  if (!root) return;

  const path = join(root, '.env');
  if (existsSync(path)) loadDotenv({ path });
}
