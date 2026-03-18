import React from "react";
import { Box, Text, useInput } from "ink";

interface HelpOverlayProps {
  onClose: () => void;
}

/**
 * Help overlay showing all keybinds and slash commands.
 * Escape to close.
 */
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
      <Text>  Tab            Switch panels</Text>
      <Text>  Enter          Expand traversal detail</Text>
      <Text>  Escape         Back / cancel</Text>
      <Text>  PageUp/Down    Scroll detail</Text>
      <Text />
      <Text bold> Actions (ctrl+x then key)</Text>
      <Text>  n              New traversal</Text>
      <Text>  r              Reset traversal</Text>
      <Text>  w              Signal wait node</Text>
      <Text>  g              Graph list</Text>
      <Text>  l              Filter traversals</Text>
      <Text>  x              Kill agent</Text>
      <Text>  h              This help</Text>
      <Text>  q              Quit</Text>
      <Text />
      <Text dimColor> Slash commands: /new /reset /signal /graphs /help /quit</Text>
      <Text />
      <Text dimColor> esc close</Text>
    </Box>
  );
}
