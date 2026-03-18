import React from "react";
import { Box, Text, useInput } from "ink";
import type { TraversalSummary } from "../../client.js";

interface ResetConfirmProps {
  traversal: TraversalSummary;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reset confirmation overlay.
 * Y to confirm, n or Escape to cancel.
 */
export function ResetConfirm({ traversal, onConfirm, onCancel }: ResetConfirmProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") return onCancel();
    if (input === "y" || input === "Y") return onConfirm();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={2} paddingY={1}>
      <Text bold> Reset Traversal</Text>
      <Text />
      <Text>Reset "{traversal.graphId}" ({traversal.id})?</Text>
      <Text dimColor>This will clear all context and history.</Text>
      <Text />
      <Text>Confirm reset? (Y/n)</Text>
    </Box>
  );
}
