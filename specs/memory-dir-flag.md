# Spec: `--memory-dir` CLI flag

## Problem

Freelance memory defaults to `.freelance/.state/memory.db` relative to the workflow directory. When Freelance ships as a Claude Code plugin, the workflow directory lives inside `${CLAUDE_PLUGIN_ROOT}` which is replaced on every plugin update — wiping the memory DB.

## Solution

Add `--memory-dir <path>` to the `freelance mcp` command.

```
freelance mcp --workflows /path/to/workflows --memory-dir /path/to/persistent/dir
```

## Behavior

When `--memory-dir` is set:
- Memory DB is stored at `<memory-dir>/memory.db`
- `memory.enabled` is implicitly `true` (no config.yml opt-in needed)
- Takes precedence over `config.yml` memory.db path

### Resolution order

```
--memory-dir flag  >  config.yml memory.db  >  default .freelance/.state/memory.db
```

### Interaction with config.yml

- `--memory-dir` overrides only the DB path. Other config.yml memory fields (`ignore`, `collections`) still apply if present.
- If `--memory-dir` is set but no config.yml exists, memory is enabled with default settings (no ignore patterns, single "default" collection).

## Plugin usage

Claude Code plugins expose two path variables:
- `${CLAUDE_PLUGIN_ROOT}` — bundled assets, replaced on update
- `${CLAUDE_PLUGIN_DATA}` — persistent storage, survives updates

This enables a plugin `.mcp.json` like:

```json
{
  "mcpServers": {
    "freelance": {
      "command": "freelance",
      "args": [
        "mcp",
        "--workflows", "${CLAUDE_PLUGIN_ROOT}/workflows",
        "--memory-dir", "${CLAUDE_PLUGIN_DATA}"
      ]
    }
  }
}
```

Result: workflows + docs ship with the plugin and update normally; memory persists across updates at a stable path; teams installing the plugin get memory automatically with zero config.

## Implementation scope

### CLI (`src/index.ts`)

Add `--memory-dir <path>` option to the `mcp` command:

```typescript
.option("--memory-dir <path>", "Persistent directory for memory database (overrides config.yml)")
```

In the `mcp` action handler, after `loadMemoryConfig(dirs)`:

```typescript
if (opts.memoryDir) {
  const memDir = path.resolve(opts.memoryDir);
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true });
  }
  const dbPath = path.join(memDir, "memory.db");
  if (memoryConfig) {
    // Override just the path, keep ignore/collections from config.yml
    memoryConfig.db = dbPath;
  } else {
    // No config.yml — enable memory with defaults
    memoryConfig = { enabled: true, db: dbPath };
  }
}
```

### Files changed

- `src/index.ts` — one new CLI option + ~10 lines of override logic in the `mcp` action handler

### Files NOT changed

- `src/server.ts` — no changes (already receives `MemoryConfig` from CLI)
- `src/memory/` — no changes (already accepts any DB path)
- Config schema — no changes (`config.yml` is unaffected)

## Test plan

- Unit: `--memory-dir` with no config.yml enables memory at specified path
- Unit: `--memory-dir` with existing config.yml overrides DB path but preserves ignore/collections
- Unit: `--memory-dir` creates directory if it doesn't exist
- Integration: full MCP flow with `--memory-dir` flag — register, emit, end, browse
