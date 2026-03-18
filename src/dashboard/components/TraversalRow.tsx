import React from "react";
import { Box, Text } from "ink";
import type { TraversalSummary } from "../client.js";

interface TraversalRowProps {
  traversal: TraversalSummary;
  selected: boolean;
  compact: boolean;
}

function formatAge(lastUpdated: string): string {
  const ms = Date.now() - new Date(lastUpdated).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TraversalRow({ traversal, selected, compact }: TraversalRowProps): React.ReactElement {
  const age = formatAge(traversal.lastUpdated);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box>
        {selected && <Text color="cyan" bold>{"❯ "}</Text>}
        {!selected && <Text>{"  "}</Text>}
        <Text color="green">● </Text>
        <Text bold={selected}>{traversal.graphId}</Text>
        <Text dimColor>{"  "}{traversal.currentNode}</Text>
        {!compact && <Text dimColor>{"  "}{age}</Text>}
      </Box>
    </Box>
  );
}
