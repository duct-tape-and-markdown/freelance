---
name: freelance-init
description: Set up Freelance in the current project via the CLI. Scaffolds .freelance/, starter templates, MCP config, and optional enforcement hooks.
disable-model-invocation: true
---

# Initialize Freelance in This Project

Run the Freelance CLI to set up this project. The CLI handles directory creation, templates, MCP config, and hook configuration.

## Steps

1. Ask the user two questions:
   - **Starter template?** Blank template (default) or no template
   - **Enable enforcement hooks?** These remind the agent to follow workflows on every prompt. Off by default.

2. Run the appropriate CLI command based on their answers:

   With hooks:
   ```bash
   freelance init --client claude-code --scope project --hooks --yes
   ```

   Without hooks (default):
   ```bash
   freelance init --client claude-code --scope project --yes
   ```

   No starter template — add `--starter none`:
   ```bash
   freelance init --client claude-code --scope project --starter none --yes
   ```

3. Confirm to the user that setup is complete and they can:
   - Add `.workflow.yaml` files to `.freelance/`
   - Add `onEnter` hook scripts to `.freelance/scripts/` (ES modules, referenced from a node's `onEnter: [{ call: ./scripts/foo.js }]`)
   - Run `freelance_list` to verify workflows load
   - Run `freelance_guide` for authoring help — including the `onenter-hooks` topic for the hook authoring surface
   - Use `freelance_distill` after completing a task to turn it into a workflow
