import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { Spinner } from "@inkjs/ui";
import { PanelLayout } from "./components/PanelLayout.js";
import { TraversalRow } from "./components/TraversalRow.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { HelpOverlay } from "./components/overlays/HelpOverlay.js";
import { usePolling } from "./hooks/usePolling.js";
import { useKeyboard, type DashboardAction } from "./hooks/useKeyboard.js";
import type { DaemonClient } from "./client.js";
import type { DashboardConfig } from "./keybinds.js";

interface AppProps {
  client: DaemonClient;
  config: DashboardConfig;
}

type Overlay = "none" | "help";

export function App({ client, config }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [graphCount, setGraphCount] = useState(0);

  // Fetch graph count once on mount
  useEffect(() => {
    client.listGraphs().then((g) => setGraphCount(g.length)).catch(() => {});
  }, [client]);

  const { traversals, selectedDetail: detail, error, loading } = usePolling(
    client,
    null, // will be overridden below
    {
      activeInterval: config.poll_interval_active,
      waitingInterval: config.poll_interval_waiting,
    }
  );

  const selectedTraversal = traversals[selectedIndex] ?? null;

  // Poll detail for selected traversal
  const { selectedDetail: detailForSelected } = usePolling(
    client,
    selectedTraversal?.traversalId ?? null,
    { activeInterval: config.poll_interval_active, waitingInterval: config.poll_interval_waiting }
  );

  // Clamp selection when traversals list changes
  useEffect(() => {
    if (selectedIndex >= traversals.length && traversals.length > 0) {
      setSelectedIndex(traversals.length - 1);
    }
  }, [traversals.length, selectedIndex]);

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
          if (selectedTraversal) setExpanded(true);
          break;
        case "back":
          if (overlay !== "none") {
            setOverlay("none");
          } else {
            setExpanded(false);
          }
          break;
        case "help":
          setOverlay("help");
          break;
        case "quit":
          exit();
          break;
      }
    },
    [traversals.length, overlay, exit, selectedTraversal, client]
  );

  const { leaderPending } = useKeyboard({
    onAction: handleAction,
    enabled: overlay === "none",
  });

  // --- Overlay handlers ---


  // --- Render ---

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

  // Overlay rendering
  if (overlay === "help") {
    return <HelpOverlay onClose={() => setOverlay("none")} />;
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
        <TraversalRow key={t.traversalId} traversal={t} selected={i === selectedIndex} compact={false} />
      ))}
    </Box>
  );

  // Right panel: detail
  const rightPanel = <DetailPanel summary={selectedTraversal} detail={detailForSelected} />;

  // Status bar — daemon only lists active traversals
  const statusBar = (
    <Box>
      <Text dimColor>
        Graphs: {graphCount}  Traversals: {traversals.length}
        {"       "}
      </Text>
      {leaderPending ? <Text color="yellow">LEADER...</Text> : <Text dimColor>ctrl+x h help  q quit</Text>}
    </Box>
  );

  return (
    <PanelLayout
      left={leftPanel}
      right={rightPanel}
      statusBar={statusBar}
      expanded={expanded}
    />
  );
}
