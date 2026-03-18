import fs from "node:fs";
import path from "node:path";

export interface KeybindConfig {
  leader: string;
  quit: string;
  new_traversal: string;
  reset: string;
  signal_wait: string;
  graph_list: string;
  filter: string;
  help: string;
  kill_agent: string;
  expand: string;
  back: string;
  panel_switch: string;
  scroll_up: string;
  scroll_down: string;
  select_up: string;
  select_down: string;
}

export interface DashboardConfig {
  keybinds: KeybindConfig;
  theme: string;
  poll_interval_active: number;
  poll_interval_waiting: number;
}

const DEFAULT_KEYBINDS: KeybindConfig = {
  leader: "ctrl+x",
  quit: "<leader>q,q",
  new_traversal: "<leader>n",
  reset: "<leader>r",
  signal_wait: "<leader>w",
  graph_list: "<leader>g",
  filter: "<leader>l",
  help: "<leader>h",
  kill_agent: "<leader>x",
  expand: "return",
  back: "escape",
  panel_switch: "tab",
  scroll_up: "pageup",
  scroll_down: "pagedown",
  select_up: "up",
  select_down: "down",
};

const DEFAULT_CONFIG: DashboardConfig = {
  keybinds: DEFAULT_KEYBINDS,
  theme: "default",
  poll_interval_active: 2000,
  poll_interval_waiting: 5000,
};

export function loadDashboardConfig(): DashboardConfig {
  const userHome = process.env.HOME || process.env.USERPROFILE || "~";
  const configPath = path.resolve(userHome, ".freelance", "dashboard.json");

  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        keybinds: { ...DEFAULT_KEYBINDS, ...raw.keybinds },
      };
    }
  } catch {
    // Invalid config — use defaults
  }

  return DEFAULT_CONFIG;
}
