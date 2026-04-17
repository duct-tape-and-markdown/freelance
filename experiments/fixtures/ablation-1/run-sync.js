#!/usr/bin/env node

// Automated sync script — pulls data from all connected services and writes
// a structured snapshot to state/sync_YYYY-MM-DD.md.
//
// This is what the Freelance sync workflow calls. It can also be run standalone:
//   node connectors/run-sync.js                  # sync last 7 days
//   node connectors/run-sync.js --since 2026-03-21  # sync from a specific date
//   node connectors/run-sync.js --json            # output raw JSON instead of markdown

const fs = require("fs");
const path = require("path");

const strava = require("./strava");
const google = require("./google-calendar");
const { loadTokens } = require("./token-store");

// Load .env
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const sinceArg = process.argv.indexOf("--since");
  const since = sinceArg > -1
    ? process.argv[sinceArg + 1]
    : new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  const until = new Date().toISOString().split("T")[0];
  const outputJson = process.argv.includes("--json");

  const results = {
    date: until,
    period: { since, until },
    connectors: [],
    strava: null,
    google: null,
  };

  // --- Strava ---
  const stravaTokens = loadTokens("strava");
  if (stravaTokens && process.env.STRAVA_CLIENT_ID) {
    try {
      results.connectors.push("strava");
      const accessToken = await strava.refreshAccessToken(
        process.env.STRAVA_CLIENT_ID,
        process.env.STRAVA_CLIENT_SECRET
      );
      const raw = await strava.getAllActivities(accessToken, {
        after: since,
        before: new Date(until + "T23:59:59").toISOString(),
      });
      const formatted = strava.formatActivities(raw);
      results.strava = strava.summarizeActivities(formatted);
      console.error(`Strava: ${results.strava.total_runs} runs, ${results.strava.total_distance_km} km`);
    } catch (err) {
      console.error(`Strava sync error: ${err.message}`);
      results.strava = { error: err.message };
    }
  } else {
    console.error("Strava: not connected");
  }

  // --- Google Calendar ---
  const googleTokens = loadTokens("google");
  if (googleTokens && process.env.GOOGLE_CLIENT_ID) {
    try {
      results.connectors.push("google");
      const accessToken = await google.refreshAccessToken(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      // For calendar, look forward (upcoming conflicts matter more than past events)
      const futureEnd = new Date(Date.now() + 10 * 86400000).toISOString();
      const events = await google.getEvents(accessToken, {
        timeMin: new Date().toISOString(),
        timeMax: futureEnd,
      });
      const formatted = google.formatEvents(events);
      results.google = google.summarizeWeek(formatted);
      console.error(`Google Calendar: ${results.google.total_events} upcoming events`);
    } catch (err) {
      console.error(`Google Calendar sync error: ${err.message}`);
      results.google = { error: err.message };
    }
  } else {
    console.error("Google Calendar: not connected");
  }

  // --- Output ---
  if (outputJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const markdown = buildMarkdown(results);

  // Write snapshot
  const stateDir = path.join(__dirname, "..", "state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const snapshotFile = path.join(stateDir, `sync_${until}.md`);
  fs.writeFileSync(snapshotFile, markdown);
  console.error(`\nSnapshot written to ${snapshotFile}`);

  // Also print to stdout
  console.log(markdown);
}

function buildMarkdown(results) {
  const lines = [];
  lines.push(`# Sync Snapshot — ${results.date}`);
  lines.push("");
  lines.push(`**Period:** ${results.period.since} to ${results.period.until}`);
  lines.push(`**Connectors:** ${results.connectors.length ? results.connectors.join(", ") : "none"}`);
  lines.push("");

  // Strava section
  lines.push("## Training Data (Strava)");
  lines.push("");
  if (!results.strava) {
    lines.push("_Not connected. Run `node connectors/cli.js auth strava` to set up._");
  } else if (results.strava.error) {
    lines.push(`_Error: ${results.strava.error}_`);
  } else {
    const s = results.strava;
    lines.push(`| Date | Type | Distance | Duration | Pace/km | Pace/mi | Avg HR | Elev |`);
    lines.push(`|------|------|----------|----------|---------|---------|--------|------|`);
    for (const a of s.activities) {
      lines.push(
        `| ${a.date} | ${a.type} | ${a.distance_km} km | ${a.duration_min} min | ${a.avg_pace_per_km || "-"} | ${a.avg_pace_per_mi || "-"} | ${a.avg_hr || "-"} | ${a.elevation_gain_m}m |`
      );
    }
    lines.push("");
    lines.push(`**Total running volume:** ${s.total_distance_km} km / ${s.total_distance_mi} mi`);
    lines.push(`**Total runs:** ${s.total_runs}`);
    lines.push(`**Total elevation:** ${s.total_elevation_m}m / ${s.total_elevation_ft}ft`);
    lines.push(`**Average HR:** ${s.avg_hr || "n/a"}`);
  }
  lines.push("");

  // Google Calendar section
  lines.push("## Schedule (Google Calendar)");
  lines.push("");
  if (!results.google) {
    lines.push("_Not connected. Run `node connectors/cli.js auth google` to set up._");
  } else if (results.google.error) {
    lines.push(`_Error: ${results.google.error}_`);
  } else {
    const g = results.google;
    lines.push(`**${g.total_events} events** across ${g.days_with_events} days`);
    if (g.busiest_day) lines.push(`**Busiest day:** ${g.busiest_day}`);
    lines.push("");

    for (const [date, events] of Object.entries(g.events_by_day).sort()) {
      lines.push(`### ${date}`);
      for (const e of events) {
        const time = e.is_all_day ? "all-day" : `${e.start}-${e.end}`;
        lines.push(`- ${time} — ${e.summary}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(`_Generated ${new Date().toISOString()}_`);
  return lines.join("\n");
}

main().catch((err) => {
  console.error(`Sync failed: ${err.message}`);
  process.exit(1);
});
