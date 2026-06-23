import { rmSync } from 'node:fs';

// Cross-platform `clean` for workspace packages. pnpm runs package scripts with
// the package directory as CWD, so these paths resolve per-package. Removes the
// build output and the incremental tsc cache (the latter otherwise persists and
// makes a subsequent `tsc` build emit nothing). Used instead of `rm -rf`, which
// is not available under cmd.exe on Windows.
for (const target of ['dist', 'tsconfig.tsbuildinfo']) {
  rmSync(target, { recursive: true, force: true });
}
