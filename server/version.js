import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

// Best-effort — a production deploy might not even have a .git directory
// present (e.g. a tarball/CI artifact deploy), so this degrades to null
// rather than crashing the admin route or, worse, boot itself.
// Also captures *why* a command failed
let lastError = null;
function readGit(cmd) {
  try {
    return execSync(cmd, { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (err) {
    // stderr is more useful than err.message here — that's where git's
    // actual "fatal: ..." explanation lives, err.message is just "Command
    // failed: git ...".
    lastError = (err.stderr?.toString().trim() || err.message || String(err)).split("\n")[0];
    return null;
  }
}

// Computed once at module load (process boot), not per-request — the
// running process's commit can't change without a restart, so there's
// no reason to shell out to git on every /admin/version hit.
const gitCommit = readGit("git rev-parse --short HEAD");
const gitBranch = readGit("git rev-parse --abbrev-ref HEAD");
const gitDirty = readGit("git status --porcelain") ? true : false;

export const versionInfo = {
  gitCommit,
  gitBranch,
  gitDirty,
  // Only present when something actually failed — absent entirely on a
  // healthy boot, so this doesn't clutter the normal case.
  ...(gitCommit == null && lastError ? { gitError: lastError } : {}),
  nodeVersion: process.version,
  bootedAt: Date.now(),
};
