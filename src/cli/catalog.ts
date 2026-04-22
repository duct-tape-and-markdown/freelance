/**
 * `freelance catalog --json` — emit a static JSON view of the error
 * catalog alongside each code's exit-category mapping and recovery
 * instruction. Pure read-only: no store, no filesystem, no network.
 * The skill body consults this when it needs to teach recovery;
 * external consumers (tooling, docs generators, CI linters) branch
 * on the same structure.
 *
 * Shape locked by `test/catalog.test.ts` round-trip: every
 * `EngineErrorCode` appears exactly once, with non-null `kind`,
 * `exit`, `recoveryKind`, and nullable `recoveryVerb`.
 */

import {
  ALL_ENGINE_ERROR_CODES,
  type EngineErrorCode,
  type ErrorKind,
  errorKind,
  RECOVERY,
  type RecoveryKind,
} from "../error-codes.js";
import { mapEngineErrorToExit, outputJson } from "./output.js";

interface CatalogEntry {
  readonly code: EngineErrorCode;
  readonly kind: ErrorKind;
  readonly exit: number;
  readonly recoveryVerb: string | null;
  readonly recoveryKind: RecoveryKind;
}

/** Build the static catalog from `ENGINE_ERROR_CODES` + `RECOVERY`. */
export function buildCatalog(): { codes: CatalogEntry[] } {
  const codes: CatalogEntry[] = ALL_ENGINE_ERROR_CODES.map((code) => ({
    code,
    kind: errorKind(code),
    exit: mapEngineErrorToExit(code),
    recoveryVerb: RECOVERY[code].verb,
    recoveryKind: RECOVERY[code].kind,
  }));
  return { codes };
}

/** CLI handler: writes the catalog JSON to stdout. */
export function catalog(): void {
  outputJson(buildCatalog());
}
