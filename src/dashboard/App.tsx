import React, { useState, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { Spinner } from "@inkjs/ui";
import { PanelLayout } from "./components/PanelLayout.js";
import { TraversalRow } from "./components/TraversalRow.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { usePolling } from "./hooks/usePolling.js";
import { useKeyboard, type DashboardAction } from "./hooks/useKeyboard.js";
import type { DaemonClient } from "./client.js";
import type { DashboardConfig } from "./keybinds.js";

interface AppProps {
  client: DaemonClient;
  config: DashboardConfig;
}

type Overlay = "none" | "help" | "graph_picker" | "reset_confirm" | "wait_signal";

export function App({ client, config }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>("none");

  const { traversals, selectedDetail, error, loading } = usePolling(client, null, {
    activeInterval: config.poll_interval_active,
    waitingInterval: config.poll_interval_waiting,
  });

  const selectedTraversal = traversals[selectedIndex] ?? null;

  // Re-poll detail for selected traversal
  const { selectedDetail: detail } = usePolling(
    client,
    selectedTraversal?.id ?? null,
    { activeInterval: config.poll_interval_active, waitingInterval: config.poll_interval_waiting }
  );

  const handleAction = useCallback(
    (action: DashboardAction) => {
      switch (action) {
        case "select_up":
          setSelectedIndex((i) => Math.max(0, i - 1));
          break;
        case "select_down":
          setSelectedIndex((i) => Math.min(traversals.length - 1, i + 1));
          break;
        case "expand":
          setExpanded(true);
          break;
        case "back":
          if (overlay !== "none") {
            setOverlay("none");
          } else {
            setExpanded(false);
          }
          break;
        case "new_traversal":
          setOverlay("graph_picker");
          break;
        case "reset":
          setOverlay("reset_confirm");
          break;
        case "signal_wait":
          setOverlay("wait_signal");
          break;
        case "help":
          setOverlay("help");
          break;
        case "quit":
          exit();
          break;
      }
    },
    [traversals.length, overlay, exit]
  );

  const { leaderPending } = useKeyboard({
    onAction: handleAction,
    enabled: overlay === "none",
  });

  if (loading) {
    return (
      <Box padding={1}>
        <Spinner label="Connecting to daemon..." />
      </Box>
    );
  }

  if (error) {
    return (
      <Box padding={1} flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  // Left panel: traversal list
  const leftPanel = (
    <Box flexDirection="column">
      <Text bold dimColor> Traversals</Text>
      {traversals.length === 0 && (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor>No active traversals. Press ctrl+x n to start one.</Text>
        </Box>
      )}
      {traversals.map((t, i) => (
        <TraversalRow key={t.id} traversal={t} selected={i === selectedIndex} compact={false} />
      ))}
    </Box>
  );

  // Right panel: detail
  const rightPanel = <DetailPanel summary={selectedTraversal} detail={detail} />;

  // Status bar
  const active = traversals.filter((t) => t.status === "active").length;
  const waiting = traversals.filter((t) => t.status === "waiting").length;
  const complete = traversals.filter((t) => t.status === "completed").length;

  const statusBar = (
    <Box>
      <Text dimColor>
        Graphs: {traversals.length}  Active: {active}  Waiting: {waiting}  Complete: {complete}
        {"       "}
        {leaderPending ? <Text color="yellow">LEADER...</Text> : <Text dimColor>ctrl+x h help  q quit</Text>}
      </Text>
    </Box>
  );

  // Overlay rendering
  if (overlay === "help") {
    return (
      <Box flexDirection="column" padding={1}>
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

  return (
    <PanelLayout
      left={leftPanel}
      right={rightPanel}
      statusBar={statusBar}
      expanded={expanded}
    />
  );
}
