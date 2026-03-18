import React from "react";
import { Box, Text } from "ink";

interface EdgeIndicatorProps {
  label: string;
  target: string;
  condition?: string;
  description?: string;
  conditionMet: boolean;
}

/**
 * Shows an available edge with a live condition indicator.
 * ● = condition currently true (edge would be taken)
 * ○ = condition currently false
 */
export function EdgeIndicator({ label, target, condition, description, conditionMet }: EdgeIndicatorProps): React.ReactElement {
  return (
    <Box>
      <Text color={conditionMet ? "green" : "red"}>
        {conditionMet ? "●" : "○"}{" "}
      </Text>
      <Text bold>{label}</Text>
      <Text dimColor> → {target}</Text>
      {condition && <Text dimColor>  ({condition})</Text>}
      {description && !condition && <Text dimColor>  {description}</Text>}
    </Box>
  );
}
