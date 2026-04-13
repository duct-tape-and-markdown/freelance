const DISTILL_PROMPT = `# Workflow Distillation

You just completed a task organically. Now let's turn what you did into a reusable Freelance workflow graph.

## Step 1: Reconstruct the process

Look back at what just happened in this conversation. Identify:

- **The discrete phases of work** — what did you do, in what order?
- **Decision points** — where did you choose between approaches?
- **Quality checks** — where did you verify something before continuing?
- **Inputs and outputs** — what information did you need, what did you produce?

List these as a numbered sequence. Be honest about what actually happened, not what you think should have happened.

## Step 2: Identify the nodes

Map each phase to a Freelance node type:

- **action** — you did work (wrote code, edited files, ran commands)
- **decision** — you evaluated options and picked a path
- **gate** — you verified something before proceeding (tests pass, review looks good, output meets criteria)
- **wait** — you needed something external (user input, CI results, approval)
- **terminal** — the task was done

Each node needs:
- A short, descriptive id (kebab-case, e.g. \`write-tests\`, \`review-output\`)
- A clear description (what this step accomplishes)
- Instructions (what the agent should do — be prescriptive)
- Edges to the next node(s) with meaningful labels

## Step 3: Define context

Identify the key state that flowed between steps:
- What did early steps produce that later steps consumed?
- What conditions controlled branching?
- What values would a gate need to check?

Define these as context fields with sensible defaults. Use context enums for fields with a known set of valid values.

## Step 4: Add enforcement

For each quality check you performed:
- Add a gate node with validation expressions
- The gate should verify context values that the preceding action sets

Don't gate everything — only gate what matters. If you didn't naturally verify something, it probably doesn't need a gate.

## Step 5: Write the graph

Produce a complete \`.workflow.yaml\` file. Follow these conventions:

- Graph id should describe the process (e.g. \`bug-fix\`, \`feature-implementation\`, \`code-review\`)
- Keep instructions actionable and specific — name files, describe approaches, list criteria
- Use edge conditions for routing, not instructions
- Set \`maxTurns\` on action nodes that could loop

Write the YAML to \`.freelance/<graph-id>.workflow.yaml\`. If the directory doesn't exist, create it.

## Step 6: Validate

Run \`freelance validate ./.freelance/\` to check the graph for structural errors. Fix any issues.

## Output format

After writing the graph, summarize:
1. What process was captured
2. How many nodes and what types
3. Where gates enforce quality
4. Suggested improvements for next iteration`;

const REFINE_PROMPT = `# Workflow Refinement

You just completed a workflow-guided task. Now let's review how the workflow performed and improve it.

## Step 1: Review the traversal

Call \`freelance_inspect\` with detail \`history\` to see the full traversal record. Then reflect:

- **Flow** — Did the node sequence match how the work actually needed to happen? Were there steps you wanted to skip, or steps missing that you had to do outside the graph?
- **Friction** — Where did the workflow fight you? Gates that blocked progress on technicalities? Decision nodes that didn't have the right edges? Instructions that were too vague or too rigid?
- **Context** — Were the context fields useful? Were you forced to set values that didn't matter, or missing fields you needed?
- **Pacing** — Were action nodes scoped right, or did some try to do too much in a single step? Were there unnecessary micro-steps that should be merged?

Be specific. Name the nodes that caused problems.

## Step 2: Categorize the issues

Group what you found:

### Remove or merge
- Nodes that were unnecessary overhead — steps the agent was forced through that added no value
- Sequential nodes that always happen together and should be one step

### Split
- Action nodes where the instructions contained multiple distinct phases that should have separate gates or decision points

### Reroute
- Edges that were missing (you wanted to skip ahead or loop back but couldn't)
- Edges with conditions that didn't match reality
- Decision nodes that needed more or fewer branches

### Tighten
- Gates with validations that were too loose (let bad work through) or too strict (blocked valid work)
- Context fields that need enums to prevent invalid values
- Missing gates where quality should have been enforced

### Rewrite
- Instructions that were ambiguous, incomplete, or misleading
- Descriptions that didn't match what the node actually required

## Step 3: Apply the changes

Read the current workflow file and edit it directly. For each change:
- Make the edit
- Briefly note why (one line)

Preserve the graph's overall structure and id. This is refinement, not a rewrite.

## Step 4: Validate

Run \`freelance validate ./.freelance/\` to check the updated graph for structural errors. Fix any issues.

## Output format

Summarize:
1. What issues were found
2. What changes were made and why
3. Nodes added, removed, or significantly changed
4. What to watch for on the next run`;

type DistillMode = "distill" | "refine";

export function getDistillPrompt(mode: DistillMode = "distill"): { content: string } {
  return { content: mode === "refine" ? REFINE_PROMPT : DISTILL_PROMPT };
}
