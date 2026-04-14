/**
 * Programmatic workflow graph construction.
 *
 * Produces the same ValidatedGraph that YAML loading produces,
 * running the same Zod schema validation, expression checking,
 * and graphlib topology checks.
 */

import { validateAndBuild } from "./loader.js";
import type { EdgeDefinition, GraphDefinition, NodeDefinition } from "./schema/graph-schema.js";
import { graphDefinitionSchema } from "./schema/graph-schema.js";
import type { ValidatedGraph } from "./types.js";

export interface NodeInput {
  type?: NodeDefinition["type"];
  description: string;
  instructions?: string;
  suggestedTools?: string[];
  maxTurns?: number;
  readOnly?: boolean;
  validations?: Array<{ expr: string; message: string }>;
  edges?: Array<{
    target: string;
    label?: string;
    condition?: string;
    description?: string;
    default?: boolean;
    nextStepHint?: string;
  }>;
  subgraph?: NodeDefinition["subgraph"];
  returns?: NodeDefinition["returns"];
  waitOn?: NodeDefinition["waitOn"];
  timeout?: string;
  sources?: NodeDefinition["sources"];
  /**
   * Programmatic node binding — required when type === "programmatic",
   * forbidden otherwise. Enforced by graph-construction validation that
   * runs during build().
   */
  operation?: NodeDefinition["operation"];
  /**
   * Map of context key → op result field name. Only valid on
   * programmatic nodes. Enforced during build().
   */
  contextUpdates?: NodeDefinition["contextUpdates"];
}

export class GraphBuilder {
  private id: string;
  private version: string = "1.0.0";
  private graphName: string;
  private description: string = "";
  private startNodeId: string | null = null;
  private contextDef: Record<string, unknown> | undefined;
  private strictContext: boolean = false;
  private nodes: Map<string, NodeInput> = new Map();

  constructor(id: string, name?: string) {
    this.id = id;
    this.graphName = name ?? id;
  }

  setVersion(version: string): this {
    this.version = version;
    return this;
  }

  setDescription(description: string): this {
    this.description = description;
    return this;
  }

  setContext(context: Record<string, unknown>, strict?: boolean): this {
    this.contextDef = context;
    if (strict !== undefined) this.strictContext = strict;
    return this;
  }

  /**
   * Add a node to the graph. If no startNode has been set, the first
   * node added becomes the startNode.
   */
  node(id: string, input: NodeInput): this {
    this.nodes.set(id, input);
    if (this.startNodeId === null) {
      this.startNodeId = id;
    }
    return this;
  }

  startNode(id: string): this {
    this.startNodeId = id;
    return this;
  }

  /**
   * Build and validate the graph. Runs the same validation pipeline
   * as YAML-loaded graphs: Zod schema, return schemas, expressions,
   * graphlib topology (reachability, cycles, terminal/gate rules).
   *
   * Op-name validation for programmatic nodes is a separate post-pass
   * (src/ops-validation.ts) run by the caller once a live ops registry
   * is available. Throws on any structural validation failure.
   */
  build(): ValidatedGraph {
    if (this.startNodeId === null) {
      throw new Error(`GraphBuilder "${this.id}": no nodes added`);
    }

    // Convert NodeInput map to the schema's record format
    const nodes: Record<string, unknown> = {};
    for (const [id, input] of this.nodes) {
      const edges = input.edges?.map(
        (e): EdgeDefinition => ({
          target: e.target,
          label: e.label ?? e.target,
          condition: e.condition,
          description: e.description,
          default: e.default,
          nextStepHint: e.nextStepHint,
        }),
      );

      nodes[id] = {
        type: input.type ?? (edges && edges.length > 0 ? "action" : "terminal"),
        description: input.description,
        instructions: input.instructions,
        suggestedTools: input.suggestedTools,
        maxTurns: input.maxTurns,
        readOnly: input.readOnly,
        validations: input.validations,
        edges,
        subgraph: input.subgraph,
        returns: input.returns,
        waitOn: input.waitOn,
        timeout: input.timeout,
        sources: input.sources,
        operation: input.operation,
        contextUpdates: input.contextUpdates,
      };
    }

    const raw: Record<string, unknown> = {
      id: this.id,
      version: this.version,
      name: this.graphName,
      description: this.description,
      startNode: this.startNodeId,
      nodes,
    };

    if (this.contextDef) {
      raw.context = this.contextDef;
      raw.strictContext = this.strictContext;
    }

    // Run through Zod — same parse as YAML loading
    const parseResult = graphDefinitionSchema.safeParse(raw);
    if (!parseResult.success) {
      const errors = parseResult.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`GraphBuilder "${this.id}" validation failed:\n${errors}`);
    }

    const definition: GraphDefinition = parseResult.data;
    const source = `GraphBuilder("${this.id}")`;
    const graph = validateAndBuild(definition, source);

    return { definition, graph };
  }
}
