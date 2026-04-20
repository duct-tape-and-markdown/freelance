# Option E: Skills-packaged workflows, minimal MCP

**Status:** paper prototype. Not wired up. Explores what Freelance would look like if each workflow were packaged as a Claude [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), with the MCP surface reduced to discovery tools only.

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

### Option E (4 MCP tools + skill-on-activation)

```
MCP tool definitions resent every turn:
  freelance_list       — "what workflows exist?"
  freelance_start      — "begin a workflow; returns traversalId + skill hint"
  freelance_inspect    — "where am I?" (compaction recovery)
  freelance_guide      — authoring help (meta; rarely called)

When a traversal starts, Claude activates the matching skill:
  skills/freelance-memory-compile/SKILL.md   (loaded once per session)
  skills/freelance-memory-recall/SKILL.md
  skills/freelance-workflow-runner/SKILL.md  (generic; user-authored workflows)
  
The skill body tells Claude to drive the traversal via Bash:
  freelance advance <edge> --json
  freelance context set key=value --json
  freelance memory emit --file props.json --json
  ...

Per-turn cost after activation: ~400-600 tokens of MCP definitions
+ skill body loaded once (~1-2K tokens, one-time).
```

Steady-state per-turn reduction: roughly **5-6×** on MCP definition weight. Skill load is a session fixed cost, not per-turn.

## Files

### `skills/freelance-memory-compile/SKILL.md`

The sealed `memory:compile` workflow as a skill. Claude activates it when the user asks to compile knowledge from sources. Skill body contains the node-by-node invocation recipe.

### `skills/freelance-memory-recall/SKILL.md`

The sealed `memory:recall` workflow as a skill. Activates when the user asks a question that could be answered from compiled memory.

### `skills/freelance-workflow-runner/SKILL.md`

The generic skill for user-authored workflows. Activates when the user invokes a non-memory workflow. Body contains the general driving recipe (start → loop advance → inspect on confusion → reset or complete), parametrized by graphId.

*Alternative:* each user workflow could codegen its own SKILL.md from the `.workflow.yaml` definition (node descriptions become skill sections, edges become decision points). That's a second prototype.

### `minimal-server.ts`

Illustrative sketch of what `src/server.ts` would register in option E. **Not wired up.** Shows the diff from current shape — 21 tools to 4.

### `cli-shape.md`

What the CLI needs to become for option E to work: JSON-first output, semantic exit codes, structured errors on stderr. Ties into issue #99's B→D transition plan.

## Token-economics sketch

Rough, per-session:

| Surface | Per-turn MCP definitions | Per-call response cost | Session skill cost |
|---|---|---|---|
| Today | ~2-3K tokens | same as before | 0 |
| Option E | ~400-600 tokens | same as before | ~1-2K tokens once |

For a 30-turn compile session:
- Today: 30 × 2.5K = 75K tokens on definitions
- Option E: 30 × 0.5K + 1.5K = **16.5K tokens** — ~4.5× reduction on the definition-weight axis alone, before touching response projection (#81).

Stacked with response projection + description diet (#81, #82), the reduction compounds.

## What this prototype does *not* show

- Actually running. The minimal server is illustrative only.
- Codegen from `.workflow.yaml` → `SKILL.md`. Flagged as follow-up.
- The `freelance exec` code-execution variant. That's a further step (Shape 2 in issue #99 option E / old option D).
- Concurrency or migration mechanics. See issue #99 for the full decision plan.

## Open questions

1. **Skill auto-activation boundary.** Claude activates skills based on the `description` field. For user-authored workflows with generic descriptions ("run my bug-fix workflow"), the `freelance-workflow-runner` generic skill may be the right catch-all. Alternatively, codegen per-workflow skills.
2. **Skill body vs guide topic.** Today `freelance_guide` serves the authoring documentation. In option E, skill bodies replace much of it for runtime drivers. Keep the guide for authors only?
3. **`memory_emit` write gate.** Currently enforced server-side ("must be inside an active traversal"). Skill activation already implies an active traversal, so the gate stays; but the agent now sees `memory_emit` only when a memory-compile-class skill is loaded. Tighter surface, same invariant.
4. **Migration path.** Ship alongside the current MCP surface (feature flag) or as a v2.0 cutover? The #99 decision drives this.

## References

- [Claude Agent Skills — overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Claude Agent Skills — SDK integration](https://platform.claude.com/docs/en/agent-sdk/skills)
- [Anthropics/skills — public skill repo](https://github.com/anthropics/skills)
- [Cloudflare Code Mode — reference implementation of progressive disclosure](https://www.infoq.com/news/2026/04/cloudflare-code-mode-mcp-server/)
- Issue #99 — CLI/MCP surface boundary decision
- Issues #81, #82 — hot-path response + description work that this stacks with
