import React from "react";
import { Box, Text } from "ink";

interface LogViewerProps {
  lines: string[];
  maxLines?: number;
}

/**
 * Read-only tail view of agent log output.
 * Shows last N lines, scrollable when parent provides scroll offset.
 */
export function LogViewer({ lines, maxLines = 20 }: LogViewerProps): React.ReactElement {
  const visible = lines.slice(-maxLines);

  if (visible.length === 0) {
    return (
      <Box>
        <Text dimColor>No log output yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={i} dimColor wrap="truncate">{line}</Text>
      ))}
    </Box>
  );
}
