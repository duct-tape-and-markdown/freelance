---
name: freelance-init
description: Scaffold the .freelance/graphs/ directory and a starter graph template in the current project.
disable-model-invocation: true
---

# Initialize Freelance in This Project

Set up the `.freelance/graphs/` directory for graph workflow definitions.

## Steps

1. Create the `.freelance/graphs/` directory in the current project root if it doesn't exist
2. Ask the user if they want a starter template:
   - **Blank template**: Create `.freelance/graphs/blank.graph.yaml` with this content:

```yaml
id: my-workflow
version: "1.0.0"
name: "My Workflow"
description: "Describe what this workflow enforces"
startNode: start

context: {}

nodes:
  start:
    type: action
    description: "First step"
    instructions: |
      What should the agent do here?
    edges:
      - target: done
        label: complete

  done:
    type: terminal
    description: "Workflow complete"
    instructions: |
      Summarize what was done.
```

   - **No template**: Just create the empty directory

3. Confirm to the user that setup is complete and they can:
   - Add `.graph.yaml` files to `.freelance/graphs/`
   - Run `freelance_list` to verify workflows load
   - Run `freelance_guide` for authoring help
