// Shared CLI output helpers and global state.
import path from "node:path";

// Exit codes per spec
export const EXIT = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  INVALID_USAGE: 2,
  GRAPH_ERROR: 3,
} as const;

// Global CLI state — set via setCli() from index.ts before any command runs.
// Exported as readonly; only setCli() can mutate it.
export interface CliState {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
}

const _cli: CliState = {
  json: false,
  quiet: false,
  verbose: false,
  noColor: false,
};

export const cli: Readonly<CliState> = _cli;

/** Initialize CLI state from parsed commander options. */
export function setCli(opts: Partial<CliState>): void {
  if (opts.json !== undefined) _cli.json = opts.json;
  if (opts.quiet !== undefined) _cli.quiet = opts.quiet;
  if (opts.verbose !== undefined) _cli.verbose = opts.verbose;
  if (opts.noColor !== undefined) _cli.noColor = opts.noColor;
}

/** Write JSON to stdout. */
export function outputJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Write informational message to stderr (progress, success, etc). */
export function info(msg: string): void {
  if (!cli.quiet) {
    process.stderr.write(`${msg}\n`);
  }
}

/** Write verbose/debug message to stderr. Scaffolding — not yet wired up. */
export function debug(msg: string): void {
  if (cli.verbose && !cli.quiet) {
    process.stderr.write(`${msg}\n`);
  }
}

/** Write error to stderr (always prints, even with --quiet). */
export function error(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Write error to stderr and exit. */
export function fatal(msg: string, exitCode: number = EXIT.GENERAL_ERROR): never {
  error(`Error: ${msg}`);
  process.exit(exitCode);
}

/** Resolve the user's home directory. */
export function homeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error("Could not determine home directory: neither HOME nor USERPROFILE is set");
  }
  return home;
}

/** Show a path relative to cwd when possible, absolute otherwise. */
export function displayPath(absPath: string): string {
  const rel = path.relative(process.cwd(), absPath);
  return rel.startsWith("..") ? absPath : rel;
}
