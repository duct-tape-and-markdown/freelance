/**
 * Zod schema for the CLI boundary of `memory emit`. The CLI reads JSON
 * from file/stdin and the engine does not: shape validation has to live
 * at the boundary or a malformed payload propagates inward as a generic
 * TypeError (e.g. iterating a string as an entity array, emitting
 * single-character entities).
 *
 * The bounds encode the documented memory invariants:
 * - `entities: 1..4` — atomic claim linked to 1–4 entities (docs/memory-intent.md § propositions).
 * - `sources: min(1)` — every proposition is source-aligned (CLAUDE.md § "Design iteration").
 * - `content: min(1)` — an empty claim hashes to "" and collides with every other empty claim.
 */

import { z } from "zod";

export const EmitPropositionSchema = z.object({
  content: z.string().min(1),
  entities: z.array(z.string().min(1)).min(1).max(4),
  sources: z.array(z.string().min(1)).min(1),
  entityKinds: z.record(z.string(), z.string()).optional(),
});

export const EmitBatchSchema = z.array(EmitPropositionSchema);
