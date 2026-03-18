import { useState, useCallback } from "react";
import { useInput } from "ink";

export type DashboardAction =
  | "select_up"
  | "select_down"
  | "expand"
  | "back"
  | "panel_switch"
  | "scroll_up"
  | "scroll_down"
  | "new_traversal"
  | "reset"
  | "signal_wait"
  | "graph_list"
  | "filter"
  | "help"
  | "kill_agent"
  | "quit"
  | "slash_command"
  | null;

interface UseKeyboardOptions {
  onAction: (action: DashboardAction) => void;
  enabled?: boolean;
}

/**
 * OpenCode-style leader key navigation.
 * ctrl+x enters leader mode, next key dispatches action.
 * Arrow keys and standard shortcuts work directly.
 */
export function useKeyboard({ onAction, enabled = true }: UseKeyboardOptions): { leaderPending: boolean } {
  const [leaderPending, setLeaderPending] = useState(false);

  useInput(
    (input, key) => {
      if (!enabled) return;

      // Leader key: ctrl+x
      if (key.ctrl && input === "x") {
        setLeaderPending(true);
        return;
      }

      // Leader mode — dispatch based on next key
      if (leaderPending) {
        setLeaderPending(false);
        switch (input) {
          case "n": return onAction("new_traversal");
          case "r": return onAction("reset");
          case "w": return onAction("signal_wait");
          case "g": return onAction("graph_list");
          case "l": return onAction("filter");
          case "h": return onAction("help");
          case "x": return onAction("kill_agent");
          case "q": return onAction("quit");
          default: return; // Unknown leader combo — ignore
        }
      }

      // Direct keys
      if (key.upArrow) return onAction("select_up");
      if (key.downArrow) return onAction("select_down");
      if (key.return) return onAction("expand");
      if (key.escape) return onAction("back");
      if (key.tab) return onAction("panel_switch");
      if (key.pageUp) return onAction("scroll_up");
      if (key.pageDown) return onAction("scroll_down");

      // Slash command trigger
      if (input === "/") return onAction("slash_command");

      // Direct quit
      if (input === "q" && !key.ctrl) return onAction("quit");
    },
    { isActive: enabled }
  );

  return { leaderPending };
}
