import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localPython = join(
  root,
  "..",
  "tools",
  "static-archives",
  "python",
  "python.exe",
);
const python =
  process.env.REA_DOCS_PYTHON ??
  (process.platform === "win32" && existsSync(localPython)
    ? localPython
    : "python3");
const result = spawnSync(
  python,
  [
    "tools/project-documentation-standard/scripts/check_docs.py",
    "--root",
    root,
    "--docs",
    "docs",
    "--route-map",
    "tools/project-documentation-standard/site-routes.json",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit", windowsHide: true, shell: false },
);
if (result.error) {
  process.stderr.write(
    "Documentation structure requires Python 3.9+. Select an existing interpreter with REA_DOCS_PYTHON; no software was installed.\n",
  );
  process.exitCode = 2;
} else process.exitCode = result.status ?? 1;
