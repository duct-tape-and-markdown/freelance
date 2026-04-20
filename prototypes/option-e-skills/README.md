# Option E: single-skill + pure CLI

**Status:** paper prototype of the target integration shape. Not wired up.

Explores what Freelance would look like if driven via a single Claude [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) plus the `freelance` CLI — with the MCP server reduced to a compatibility fallback for the narrow non-shell audience (Claude Desktop).

## The shape

### Today (~21 MCP tools, always loaded)

```
MCP tool definitions resent every turn:
  freelance_list, freelance_start, freelance_advance, freelance_context_set,
  freelance_meta_set, freelance_inspect, freelance_reset, freelance_guide,
  freelance_distill, freelance_validate, freelance_sources_hash,
  freelance_sources_check, freelance_sources_validate,
  memory_emit, memory_browse, memory_inspect, memory_by_source,
  memory_search, memory_related, memory_status, memory_reset
  
Per-turn cost: ~2-3K tokens of definitions, regardless of whether
any freelance tool is called this turn.
```

### Option E (single skill, pure CLI, no MCP in the hot path)

```
MCP tool definitions per turn: 0 (skill path doesn't use MCP)
  
Skill activates from description match:
  .claude/skills/freelance/SKILL.md   (loaded once per session, ~2K tokens)
  
Skill body teaches the invariant protocol. Agent shells out:
  freelance status --json
  freelance start <graphId> --json
  freelance advance <edge> --json
  freelance context set key=value --json
  freelance inspect --detail position --json
  freelance memory emit --file props.json --json
  ...

The workflow's node instructions carry domain knowledge JIT via each
response. Skill doesn't need per-workflow content.
```

Per-turn MCP definition weight drops from ~2-3K to **zero**. Skill load is a one-time session cost (~2K tokens). Net: the skill pays for itself in the first ~1-2 turns and everything after is free on the definition-weight axis.

## Why a single skill, not one per workflow

Earlier drafts of this prototype had per-workflow skills (compile / recall / generic runner). That conflated two distinct concerns:

- **Workflows enforce and teach domain.** The `.workflow.yaml` already carries node instructions, edge descriptions, validation messages. Every `advance` response returns the new node's full teaching surface. The agent learns each workflow's shape JIT.
- **The skill carries the invariant protocol.** How to drive ANY workflow — discover, start, loop, recover, exit. That pattern doesn't vary per workflow.

One skill for the protocol, the workflow for the domain. No codegen, no drift, no per-workflow artifact to maintain. User-authored workflows cost nothing extra.

## Files

### `skills/freelance/SKILL.md`

The single skill. Frontmatter + body (~100 lines). Teaches the driving protocol; references the CLI exclusively.

### `minimal-server.ts`

Illustrative sketch of an MCP fallback server for Claude Desktop and other non-shell clients. Registers a small tool set (discovery + runtime verbs) so Freelance remains usable in those environments without the CLI path. **Not the primary surface — just the compatibility shim.** See issue #99 for the full surface decision.

### `cli-shape.md`

What the CLI needs to become for the skill path to work well: JSON-first output as default, semantic exit codes, structured errors mirroring MCP's shape. These requirements are non-negotiable under option E (the skill body assumes them); they're enabling work, not optional polish.

## Token-economics sketch

Per-session, for a 30-turn workflow:

| Surface | Per-turn MCP cost | Skill load (once) | Approx. session total |
|---|---|---|---|
| Today | ~2.5K tokens | 0 | **~75K tokens** on definitions |
| Option E (skill + CLI) | 0 | ~2K tokens | **~2K tokens** on definitions |
| Option E (non-shell fallback) | ~2.5K tokens | 0 | ~75K tokens (same as today) |

The skill path is ~35× more efficient on definition-weight for shell-capable clients. Non-shell clients fall back to today's cost profile.

Stacked with response projection (#81) and description diet (#82), reductions compound on both paths.

## What this prototype does *not* show

- Actual runtime. The minimal server is illustrative; the skill SKILL.md is not deployed to `.claude/skills/`.
- A `freelance daemon` + unix-socket optimization for the CLI cold-start. ~200ms/invocation is tolerable; daemon is a follow-up if measurement says otherwise.
- Migration mechanics. How today's MCP surface users transition — see #99.

## Audience alignment

Freelance's real audience is coding and automation agents, which are shell-capable almost everywhere:

- Claude Code (web, CLI, desktop, IDE) — native Bash
- Cursor, Windsurf, Cline — terminal agents
- Claude Agent SDK (remote + managed) — shell tool usually exposed
- CI pipelines driving agents — shell is the pipeline
- **Claude Desktop chat** — the one meaningful non-shell client; MCP compatibility serves this case

The skill path bets on the dominant real-world usage pattern. MCP is maintained for the edge case.

## Open questions

1. **Skill activation matching.** The single-skill description needs to be broad enough to trigger for compile/recall/user-workflow requests but specific enough not to activate on every work-related prompt. Tunable via the `description` frontmatter field after initial measurement.
2. **CLI cold-start wall time.** Node startup + config load + graph load is ~200ms per CLI call. Usability test with real workflow driving; daemon path becomes worthwhile if it's annoying.
3. **Subgraph teaching.** The skill mentions subgraphs; whether the one-paragraph description suffices or authors need richer in-workflow instructions is a measurement question.
4. **Claude Desktop MCP surface shape.** Whether the fallback surface should match today's 21-tool shape, a trimmed variant per #82, or a `freelance_exec`-style code-execution tool (#99 option D shape) is a separate decision.

## References

- [Claude Agent Skills — overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Claude Agent Skills — SDK integration](https://platform.claude.com/docs/en/agent-sdk/skills)
- [Anthropics/skills — public skill repo](https://github.com/anthropics/skills)
- [Cloudflare Code Mode — reference implementation of progressive disclosure](https://www.infoq.com/news/2026/04/cloudflare-code-mode-mcp-server/)
- Issue #99 — CLI/MCP surface boundary decision
- Issues #81, #82 — hot-path response + description work for the MCP fallback path
