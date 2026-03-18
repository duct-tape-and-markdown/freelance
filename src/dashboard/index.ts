import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { DaemonClient, DaemonConnectionError } from "./client.js";
import { loadDashboardConfig } from "./keybinds.js";

export interface DashboardOptions {
  host: string;
  port: number;
}

export async function startDashboard(options: DashboardOptions): Promise<void> {
  const client = new DaemonClient({ host: options.host, port: options.port });

  // Verify daemon is reachable
  try {
    await client.health();
  } catch (err) {
    if (err instanceof DaemonConnectionError) {
      throw err;
    }
    throw new Error(`Cannot connect to daemon at ${options.host}:${options.port}. Is it running?\n  Start with: freelance daemon start`);
  }

  const config = loadDashboardConfig();

  const { waitUntilExit } = render(
    React.createElement(App, { client, config })
  );

  await waitUntilExit();
}
