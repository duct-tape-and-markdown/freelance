import React from "react";
import { Box, Text } from "ink";
import type { TraversalDetail, TraversalSummary } from "../client.js";

interface AgentInfo {
  status: string;
  pid?: number;
  agentType?: string;
  registeredAt?: string;
}

interface DetailPanelProps {
  summary: TraversalSummary | null;
  detail: TraversalDetail | null;
  agent?: AgentInfo | null;
  logLines?: string[];
}

const NODE_TYPE_COLORS: Record<string, string> = {
  action: "green",
  gate: "yellow",
  decision: "blue",
  wait: "magenta",
  terminal: "gray",
};

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>── {title} {"─".repeat(Math.max(0, 40 - title.length))}</Text>
      {children}
    </Box>
  );
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function DetailPanel({ summary, detail, agent, logLines }: DetailPanelProps): React.ReactElement {
  if (!summary || !detail) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>Select a traversal to view details</Text>
      </Box>
    );
  }

  const nodeColor = NODE_TYPE_COLORS[detail.node?.type ?? "action"] ?? "white";

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Text bold>{summary.graphId} v{summary.graphVersion}</Text>
      <Text dimColor>({summary.id})</Text>

      {/* Current node */}
      <Box marginTop={1}>
        <Text>Node: </Text>
        <Text bold>{detail.currentNode}</Text>
        <Text> </Text>
        <Text color={nodeColor}>({detail.node?.type})</Text>
      </Box>

      {/* Agent */}
      {agent && agent.status !== "none" && (
        <Section title="Agent">
          <Box>
            <Text>{agent.agentType ?? "unknown"} (pid {agent.pid})</Text>
            <Text>{"  "}</Text>
            <Text color={agent.status === "running" ? "green" : "yellow"}>
              {agent.status === "running" ? "● running" : "⚠ exited"}
            </Text>
          </Box>
        </Section>
      )}

      {/* Agent Log */}
      {logLines && logLines.length > 0 && (
        <Section title={`Agent Log (last ${logLines.length} lines)`}>
          {logLines.map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Section>
      )}

      {/* Context */}
      <Section title="Context">
        {Object.entries(detail.context).map(([key, value]) => (
          <Box key={key}>
            <Text color="cyan">{key}</Text>
            <Text dimColor>: </Text>
            <Text>{typeof value === "object" ? JSON.stringify(value) : String(value)}</Text>
          </Box>
        ))}
      </Section>

      {/* History */}
      {detail.history && detail.history.length > 0 && (
        <Section title="History">
          {detail.history.map((entry, i) => (
            <Box key={i}>
              <Text dimColor>{formatTimestamp(entry.timestamp)}  </Text>
              <Text>{entry.from}</Text>
              <Text dimColor> → </Text>
              <Text color="cyan">{entry.edge}</Text>
              <Text dimColor> → </Text>
              <Text>{entry.to}</Text>
            </Box>
          ))}
        </Section>
      )}

      {/* Available edges */}
      {detail.validTransitions.length > 0 && (
        <Section title="Edges">
          {detail.validTransitions.map((edge) => (
            <Box key={edge.label}>
              <Text color={edge.conditionMet ? "green" : "red"}>
                {edge.conditionMet ? "●" : "○"}{" "}
              </Text>
              <Text bold>{edge.label}</Text>
              <Text dimColor> → {edge.target}</Text>
              {edge.condition && <Text dimColor>  ({edge.condition})</Text>}
            </Box>
          ))}
        </Section>
      )}
    </Box>
  );
}
