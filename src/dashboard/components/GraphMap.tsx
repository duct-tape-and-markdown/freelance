import React from "react";
import { Box, Text } from "ink";

interface GraphNode {
  type: string;
  description: string;
  edges?: Array<{ target: string; label: string }>;
}

interface GraphMapProps {
  nodes: Record<string, GraphNode>;
  startNode: string;
  currentNode: string;
  visitedNodes: Set<string>;
}

/**
 * Simplified ASCII graph map showing traversal progress.
 * Current node in [brackets], visited nodes normal, unvisited dimmed.
 * Branch points shown with tree-style indentation.
 */
export function GraphMap({ nodes, startNode, currentNode, visitedNodes }: GraphMapProps): React.ReactElement {
  const lines = buildMapLines(nodes, startNode, currentNode, visitedNodes);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line.prefix}{renderNode(line.node, currentNode, visitedNodes)}{line.suffix}</Text>
      ))}
    </Box>
  );
}

interface MapLine {
  prefix: string;
  node: string;
  suffix: string;
}

function renderNode(node: string, currentNode: string, visitedNodes: Set<string>): React.ReactElement {
  if (node === currentNode) {
    return <Text color="cyan" bold>[{node}]</Text>;
  }
  if (visitedNodes.has(node)) {
    return <Text>{node}</Text>;
  }
  return <Text dimColor>{node}</Text>;
}

function buildMapLines(
  nodes: Record<string, GraphNode>,
  startNode: string,
  currentNode: string,
  visitedNodes: Set<string>
): MapLine[] {
  const lines: MapLine[] = [];
  const visited = new Set<string>();
  const queue: Array<{ node: string; indent: number; prefix: string }> = [
    { node: startNode, indent: 0, prefix: "" },
  ];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.node)) continue;
    visited.add(item.node);

    const nodeInfo = nodes[item.node];
    const edges = nodeInfo?.edges ?? [];

    if (edges.length <= 1) {
      // Linear — show on same line with arrow
      const suffix = edges.length === 1 ? " → " : "";
      lines.push({ prefix: item.prefix, node: item.node, suffix });

      if (edges.length === 1 && !visited.has(edges[0].target)) {
        queue.unshift({ node: edges[0].target, indent: item.indent, prefix: "" });
      }
    } else {
      // Branch point
      lines.push({ prefix: item.prefix, node: item.node, suffix: "" });

      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        if (visited.has(edge.target)) continue;
        const isLast = i === edges.length - 1;
        const branchPrefix = "  ".repeat(item.indent + 1) + (isLast ? "└─ " : "├─ ");
        queue.unshift({
          node: edge.target,
          indent: item.indent + 1,
          prefix: branchPrefix,
        });
      }
    }
  }

  return lines;
}
