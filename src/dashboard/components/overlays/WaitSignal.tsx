import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { TraversalSummary } from "../../client.js";

interface WaitField {
  key: string;
  value: string;
}

interface WaitSignalProps {
  traversal: TraversalSummary;
  waitKeys: string[];
  onSubmit: (updates: Record<string, unknown>) => void;
  onCancel: () => void;
}

/**
 * Wait node signal overlay with dynamic form fields.
 * Tab between fields, Enter to submit, Escape to cancel.
 */
export function WaitSignal({ traversal, waitKeys, onSubmit, onCancel }: WaitSignalProps): React.ReactElement {
  const [fields, setFields] = useState<WaitField[]>(
    waitKeys.map((key) => ({ key, value: "" }))
  );
  const [activeField, setActiveField] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab) {
      setActiveField((i) => (i + 1) % fields.length);
      return;
    }
    if (key.return && !submitting) {
      setSubmitting(true);
      const updates: Record<string, unknown> = {};
      for (const field of fields) {
        // Attempt to parse as JSON for booleans/numbers
        try {
          updates[field.key] = JSON.parse(field.value);
        } catch {
          updates[field.key] = field.value;
        }
      }
      onSubmit(updates);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
      <Text bold> Signal Wait Node</Text>
      <Text />
      <Text>Traversal: {traversal.graphId} ({traversal.id})</Text>
      <Text dimColor>Waiting on:</Text>
      <Text />

      {fields.map((field, i) => (
        <Box key={field.key}>
          <Text color={i === activeField ? "cyan" : undefined}>
            {field.key}: {" "}
          </Text>
          {i === activeField ? (
            <TextInput
              defaultValue={field.value}
              onChange={(value) => {
                setFields((prev) => prev.map((f, idx) => idx === i ? { ...f, value } : f));
              }}
            />
          ) : (
            <Text dimColor>{field.value || "(empty)"}</Text>
          )}
        </Box>
      ))}

      <Text />
      <Text dimColor>tab next field  enter submit  esc cancel</Text>
    </Box>
  );
}
