import path from "node:path";

export const FREELANCE_DIR = ".freelance";
export const TRAVERSALS_DIR = path.join(FREELANCE_DIR, "traversals");
export const DEFAULT_PORT = (() => {
  const env = process.env.FREELANCE_DAEMON_PORT;
  if (!env) return 7433;
  const parsed = parseInt(env, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    process.stderr.write(`Warning: FREELANCE_DAEMON_PORT="${env}" is not a valid port, using 7433\n`);
    return 7433;
  }
  return parsed;
})();

export function getPidFilePath(): string {
  return path.resolve(FREELANCE_DIR, "daemon.pid");
}
