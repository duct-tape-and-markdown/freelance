import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { DaemonClient, GraphInfo } from "../../client.js";

interface GraphPickerProps {
  client: DaemonClient;
  onSelect: (graphId: string) => void;
  onCancel: () => void;
}

/**
 * Graph picker overlay for starting a new traversal.
 * Arrow keys to navigate, Enter to confirm, Escape to cancel.
 */
export function GraphPicker({ client, onSelect, onCancel }: GraphPickerProps): React.ReactElement {
  const [graphs, setGraphs] = useState<GraphInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.listGraphs().then((g) => {
      setGraphs(g);
      setLoading(false);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
  }, [client]);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(graphs.length - 1, i + 1));
    if (key.return && graphs.length > 0) {
      onSelect(graphs[selectedIndex].id);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold> New Traversal</Text>
      <Text />

      {loading && <Text dimColor>Loading graphs...</Text>}
      {error && <Text color="red">Error: {error}</Text>}

      {!loading && !error && graphs.length === 0 && (
        <Text dimColor>No graphs available.</Text>
      )}

      {!loading && !error && (
        <>
          <Text dimColor>Select a graph:</Text>
          <Text />
          {graphs.map((g, i) => (
            <Box key={g.id}>
              <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                {i === selectedIndex ? "> " : "  "}
                {g.id}
              </Text>
              <Text dimColor>{"  "}{g.description?.slice(0, 50)}</Text>
            </Box>
          ))}
          <Text />
          <Text dimColor>↑↓ select  enter start  esc cancel</Text>
        </>
      )}
    </Box>
  );
}
