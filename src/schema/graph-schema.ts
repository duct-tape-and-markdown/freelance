import { z } from "zod";

const returnFieldType = z.enum(["boolean", "string", "number", "array", "object"]);

export const returnFieldSchema = z.object({
  type: returnFieldType,
  items: returnFieldType.optional(),
  description: z.string().optional(),
});

export const returnSchemaDefinition = z.object({
  required: z.record(z.string(), returnFieldSchema).optional(),
  optional: z.record(z.string(), returnFieldSchema).optional(),
});

export const edgeDefinitionSchema = z.object({
  target: z.string(),
  label: z.string(),
  condition: z.string().optional(),
  description: z.string().optional(),
  default: z.boolean().optional(),
});

export const validationRuleSchema = z.object({
  expr: z.string(),
  message: z.string(),
});

export const subgraphDefinitionSchema = z.object({
  graphId: z.string(),
  condition: z.string().optional(),
  initialContext: z.record(z.string(), z.unknown()).optional(),
  contextMap: z.record(z.string(), z.string()).optional(),
  returnMap: z.record(z.string(), z.string()).optional(),
});

export const waitOnEntrySchema = z.object({
  key: z.string(),
  type: z.enum(["boolean", "string", "number", "array", "object"]),
  description: z.string().optional(),
});

export const nodeDefinitionSchema = z.object({
  type: z.enum(["action", "decision", "gate", "terminal", "wait"]),
  description: z.string(),
  instructions: z.string().optional(),
  suggestedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).optional(),
  validations: z.array(validationRuleSchema).optional(),
  edges: z.array(edgeDefinitionSchema).optional(),
  subgraph: subgraphDefinitionSchema.optional(),
  returns: returnSchemaDefinition.optional(),
  waitOn: z.array(waitOnEntrySchema).optional(),
  timeout: z.string().optional(),
});

export const graphDefinitionSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  startNode: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  strictContext: z.boolean().optional().default(false),
  nodes: z.record(z.string(), nodeDefinitionSchema),
});

// Derive TypeScript types from zod schemas — single source of truth
export type EdgeDefinition = z.infer<typeof edgeDefinitionSchema>;
export type ValidationRule = z.infer<typeof validationRuleSchema>;
export type SubgraphDefinition = z.infer<typeof subgraphDefinitionSchema>;
export type ReturnField = z.infer<typeof returnFieldSchema>;
export type ReturnSchema = z.infer<typeof returnSchemaDefinition>;
export type WaitOnEntry = z.infer<typeof waitOnEntrySchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;
