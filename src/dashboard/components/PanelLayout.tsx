import React, { useState, type ReactNode } from "react";
import { Box, Text, useStdout } from "ink";

export type LayoutMode = "wide" | "medium" | "narrow";

interface PanelLayoutProps {
  left: ReactNode;
  right: ReactNode;
  statusBar: ReactNode;
  expanded: boolean;
  onLayoutMode?: (mode: LayoutMode) => void;
}

function getLayoutMode(columns: number): LayoutMode {
  if (columns >= 120) return "wide";
  if (columns >= 80) return "medium";
  return "narrow";
}

/**
 * Two-panel responsive layout.
 *
 * - Wide (>=120 cols): full two-panel, left 40% / right 60%
 * - Medium (80-119): narrower left panel (status + name only)
 * - Narrow (<80): single panel, `expanded` toggles which panel is visible
 */
export function PanelLayout({ left, right, statusBar, expanded }: PanelLayoutProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const mode = getLayoutMode(columns);

  // Narrow: single panel mode
  if (mode === "narrow") {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexGrow={1}>
          {expanded ? right : left}
        </Box>
        <Box>{statusBar}</Box>
      </Box>
    );
  }

  // Expanded: detail panel takes full width
  if (expanded) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexGrow={1}>{right}</Box>
        <Box>{statusBar}</Box>
      </Box>
    );
  }

  // Two-panel layout
  const leftWidth = mode === "wide" ? Math.floor(columns * 0.4) : Math.floor(columns * 0.3);
  const rightWidth = columns - leftWidth - 1; // 1 for border

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexGrow={1}>
        <Box width={leftWidth} flexDirection="column">
          {left}
        </Box>
        <Box width={1} flexDirection="column">
          <Text dimColor>│</Text>
        </Box>
        <Box width={rightWidth} flexDirection="column">
          {right}
        </Box>
      </Box>
      <Box>{statusBar}</Box>
    </Box>
  );
}
