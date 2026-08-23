import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

// Best-effort — a production deploy might not even have a .git directory
// present (e.g. a tarball/CI artifact deploy), so this degrades to null
// rather than crashing the admin route or, worse, boot itself.
function readGit(cmd) {
  try {
    return execSync(cmd, { cwd: serverDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

// Computed once at module load (process boot), not per-request — the
// running process's commit can't change without a restart, so there's
// no reason to shell out to git on every /admin/version hit.
export const versionInfo = {
  gitCommit: readGit("git rev-parse --short HEAD"),
  gitBranch: readGit("git rev-parse --abbrev-ref HEAD"),
  gitDirty: readGit("git status --porcelain") ? true : false,
  nodeVersion: process.version,
  bootedAt: Date.now(),
};
