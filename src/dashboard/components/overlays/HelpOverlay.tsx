import React from "react";
import { Box, Text, useInput } from "ink";

interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) return onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
      <Text bold> Dashboard Help</Text>
      <Text />
      <Text bold> Navigation</Text>
      <Text>  ↑/↓           Select traversal</Text>
      <Text>  Enter          Expand traversal detail</Text>
      <Text>  Escape         Collapse / close overlay</Text>
      <Text />
      <Text bold> Actions (ctrl+x then key)</Text>
      <Text>  h              This help</Text>
      <Text>  q              Quit</Text>
      <Text />
      <Text dimColor> q also quits directly</Text>
      <Text />
      <Text dimColor> esc close</Text>
    </Box>
  );
}
