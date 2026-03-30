# Changelog

## Unreleased (2026-03-28 – 2026-03-29)

### Added
- **Claude Code plugin** — self-contained plugin (`plugin/`) with MCP server config, hooks, and skills for one-command installation (#14)
- **Graph-level and node-level source bindings** — sources now included in every traversal response, not just on start (#16, #17)
- **Source context in gate errors** — `graphSources` threaded through gate error results so agents get source context when self-correcting (#16)
- **`--source-root` CLI flag** — explicit override for source path resolution base directory (#23)
- **Static enum validation for context fields** — context fields accept `enum: [...]` declarations; `freelance validate` catches mismatched values at load time (#19)
- **Array shorthand for subgraph maps** — `contextMap` and `returnMap` accept `[key1, key2]` as shorthand for same-name mappings (#21)
- **Recursive directory scanning** — `.workflow.yaml` files discovered at any depth under `.freelance/`
- **Graceful zero-graph startup** — MCP server starts cleanly with no graphs instead of crashing
- **Conventions guide topic** — authoring best practices added to `freelance_guide`
- **Migration workflow templates** — `migrate-context-enums.workflow.yaml`, `migrate-shorthand-maps.workflow.yaml`

### Changed
- **Tool prefix rename** — all MCP tools renamed from `graph_*` to `freelance_*` (#14)
- **File extension rename** — `.graph.yaml` renamed to `.workflow.yaml` across all source, tests, fixtures, templates, and docs (#14)
- **CLI flag rename** — `--graphs` renamed to `--workflows`; env var renamed to `FREELANCE_WORKFLOWS_DIR` (#14)
- **Directory convention simplified** — `.freelance/` is now the workflow root directly (dropped `/graphs` subdirectory) (#14)
- **Source path resolution** — paths now resolve relative to the parent of the first `graphsDir` instead of `process.cwd()` (#23)

### Fixed
- `freelance_sources_validate` resolving paths relative to graph file directory instead of CWD (#16, #17)
- Orphaned JSDoc on `evaluate()` in `evaluator.ts`
