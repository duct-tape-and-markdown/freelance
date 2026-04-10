# Spec: Simplify memory configuration

## Problem

Memory currently requires a `config.yml` with `memory.enabled: true` — an explicit gate that adds friction to first-time setup. Combined with the proposed `--memory-dir` flag, the configuration surface becomes three overlapping layers (defaults, config file, CLI flag) for what should be a simple feature.

Additionally, when Freelance ships as a Claude Code plugin, the workflow directory lives inside `${CLAUDE_PLUGIN_ROOT}` which is replaced on every plugin update — wiping the memory DB.

## Design principles

1. **Zero-config by default** — memory should work out of the box with no config file
2. **CLI flags for deployment overrides** — the plugin/team case uses MCP client config (`.mcp.json` args), not server-side YAML
3. **Config file for advanced tuning only** — collections, ignore patterns. Optional overlay, never required
4. **Standard precedence** — defaults < config file < env vars < CLI flags (matches Git, Terraform, Docker)

## Solution

### 1. Memory on by default

Remove the `enabled: true` gate. When Freelance starts, memory is enabled automatically with:

- **DB path**: `.freelance/.state/memory.db` (project-level, same as traversal state)
- **Collections**: single `default` collection (`{ name: "default", description: "General project knowledge", paths: [""] }`)
- **Ignore**: none

No `config.yml` needed. Install Freelance → memory works.

### 2. `--memory-dir` CLI flag for persistent override

```
freelance mcp --memory-dir /path/to/persistent/dir
```

When set:
- Memory DB is stored at `<memory-dir>/memory.db`
- Takes highest precedence for DB path
- Does **not** affect collections/ignore (those come from config.yml if present)

### 3. `config.yml` becomes an optional overlay

If `.freelance/config.yml` exists and has a `memory` section, it layers on top of defaults:

```yaml
memory:
  # 'enabled' field is removed — memory is always on
  # 'db' field is removed — use --memory-dir flag or accept the default
  ignore:
    - "**/node_modules/**"
    - "**/dist/**"
  collections:
    - name: default
      description: General project knowledge
      paths: [""]
    - name: spec
      description: Feature specifications and design decisions
      paths: ["docs/", "specs/"]
```

Only `ignore` and `collections` remain in config.yml. The `enabled` and `db` fields are removed from the config schema.

### 4. Opt-out via `--no-memory`

For users who don't want memory at all:

```
freelance mcp --no-memory
```

This replaces the `enabled: false` config field with a CLI flag.

## Precedence (final)

```
--no-memory (disables entirely)
    ↓
--memory-dir <path>/memory.db  (CLI flag, highest for DB path)
    ↓
.freelance/.state/memory.db  (default)
```

Collections/ignore: `config.yml` if present, else defaults.

## Plugin usage

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

Workflows ship with the plugin; memory persists at a stable path; teams get memory automatically with zero config.

## Implementation scope

### CLI (`src/index.ts`)

**Add flags** to the `mcp` command:

```typescript
.option("--memory-dir <path>", "Persistent directory for memory database")
.option("--no-memory", "Disable memory")
```

**Replace** `loadMemoryConfig()` with `resolveMemoryConfig()`:

```typescript
function resolveMemoryConfig(
  graphsDirs: string[],
  opts: { memoryDir?: string; memory?: boolean }
): MemoryConfig | null {
  // Opt-out
  if (opts.memory === false) return null;

  // Default DB path
  let dbPath = path.join(ensureStateDir(graphsDirs[0] ?? ".freelance"), "memory.db");

  // CLI flag override
  if (opts.memoryDir) {
    const memDir = path.resolve(opts.memoryDir);
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }
    dbPath = path.join(memDir, "memory.db");
  }

  // Load optional overlay from config.yml (collections, ignore only)
  let ignore: string[] | undefined;
  let collections: CollectionConfig[] | undefined;
  for (const dir of graphsDirs) {
    const configPath = path.join(dir, "config.yml");
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = yaml.load(raw) as Record<string, unknown>;
        if (config?.memory && typeof config.memory === "object") {
          const mem = config.memory as Record<string, unknown>;
          if (Array.isArray(mem.ignore)) ignore = mem.ignore as string[];
          if (Array.isArray(mem.collections)) {
            collections = (mem.collections as Array<Record<string, unknown>>)
              .map((c) => ({
                name: String(c.name ?? ""),
                description: String(c.description ?? ""),
                paths: Array.isArray(c.paths) ? (c.paths as string[]) : [],
              }))
              .filter((c) => c.name.length > 0);
          }
        }
      } catch {
        // Config parse failure — use defaults
      }
      break;
    }
  }

  return { enabled: true, db: dbPath, ignore, collections };
}
```

**Update** the `mcp` action handler:

```typescript
const memoryConfig = resolveMemoryConfig(dirs, {
  memoryDir: opts.memoryDir,
  memory: opts.memory,
});
```

### Migration

- `config.yml` files with `memory.enabled` and `memory.db` continue to parse without error (fields are simply ignored)
- No breaking change — existing setups keep working, they just no longer need those fields
- `freelance init` should stop generating `memory.enabled` and `memory.db` in new config files

### Files changed

- `src/index.ts` — replace `loadMemoryConfig` with `resolveMemoryConfig`, add two CLI options
- `templates/` — update any config.yml templates to remove `enabled`/`db` fields

### Files NOT changed

- `src/server.ts` — still receives `MemoryConfig` unchanged
- `src/memory/` — no changes (already accepts any config shape)
- `MemoryConfig` type — keep `enabled` and `db` fields (they're still used internally)

## Test plan

- Unit: memory enabled by default with no config.yml
- Unit: `--no-memory` disables memory entirely
- Unit: `--memory-dir` overrides DB path, creates directory if needed
- Unit: `config.yml` with only `ignore`/`collections` layers correctly onto defaults
- Unit: legacy `config.yml` with `enabled`/`db` fields doesn't break (fields ignored)
- Unit: `--memory-dir` + `config.yml` collections — flag wins for DB, config wins for collections
- Integration: full MCP flow with zero config — register, emit, browse
- Integration: full MCP flow with `--memory-dir` flag
