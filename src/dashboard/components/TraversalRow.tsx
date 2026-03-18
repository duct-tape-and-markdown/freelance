import React from "react";
import { Box, Text } from "ink";
import type { TraversalSummary } from "../client.js";

interface AgentInfo {
  status: string;
  pid?: number;
  agentType?: string;
}

interface TraversalRowProps {
  traversal: TraversalSummary;
  selected: boolean;
  compact: boolean; // medium terminal — hide progress bar
  agent?: AgentInfo | null;
}

const STATUS_INDICATORS: Record<string, { symbol: string; color: string }> = {
  active: { symbol: "●", color: "green" },
  waiting: { symbol: "◌", color: "yellow" },
  completed: { symbol: "✓", color: "gray" },
  failed: { symbol: "✗", color: "red" },
};

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function renderProgressBar(visited: number, total: number, width: number): string {
  if (total === 0) return "";
  const filled = Math.round((visited / total) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function TraversalRow({ traversal, selected, compact, agent }: TraversalRowProps): React.ReactElement {
  const statusInfo = STATUS_INDICATORS[traversal.status] ?? STATUS_INDICATORS.active;
  const duration = formatDuration(traversal.startedAt);
  const progress = `${traversal.visitedNodes}/${traversal.nodeCount}`;

  const agentLabel = agent && agent.status !== "none"
    ? `  agent: ${agent.agentType ?? "?"} (pid ${agent.pid})`
    : "";

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box>
        {selected && <Text color="cyan" bold>{"❯ "}</Text>}
        {!selected && <Text>{"  "}</Text>}
        <Text color={statusInfo.color}>{statusInfo.symbol} </Text>
        <Text bold={selected}>{traversal.graphId}</Text>
        <Text dimColor>{"  "}{traversal.currentNode}</Text>
        {agentLabel && <Text dimColor>{agentLabel}</Text>}
      </Box>
      {!compact && (
        <Box paddingLeft={selected ? 4 : 4}>
          <Text color="cyan">{renderProgressBar(traversal.visitedNodes, traversal.nodeCount, 16)}</Text>
          <Text dimColor>{"  "}{progress}  {duration}</Text>
        </Box>
      )}
    </Box>
  );
}
