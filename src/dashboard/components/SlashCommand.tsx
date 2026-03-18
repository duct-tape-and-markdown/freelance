import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { DashboardAction } from "../hooks/useKeyboard.js";

interface SlashCommandProps {
  onAction: (action: DashboardAction) => void;
  onCancel: () => void;
}

const COMMANDS: Record<string, DashboardAction> = {
  new: "new_traversal",
  reset: "reset",
  signal: "signal_wait",
  graphs: "graph_list",
  filter: "filter",
  help: "help",
  quit: "quit",
};

/**
 * Slash command input bar shown in the status area.
 * Type a command, Enter to execute, Escape to cancel.
 */
export function SlashCommand({ onAction, onCancel }: SlashCommandProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) return onCancel();
  });

  const handleSubmit = (input: string) => {
    const trimmed = input.trim().replace(/^\//, "");
    const action = COMMANDS[trimmed];
    if (action) {
      onAction(action);
    } else {
      setError(`Unknown command: /${trimmed}`);
    }
  };

  return (
    <Box>
      <Text color="cyan">/</Text>
      <TextInput
        defaultValue={value}
        onChange={(v) => { setValue(v); setError(null); }}
        onSubmit={handleSubmit}
      />
      {error && <Text color="red">  {error}</Text>}
    </Box>
  );
}
