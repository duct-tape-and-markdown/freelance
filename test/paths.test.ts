import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let stderrSpy: ReturnType<typeof vi.spyOn<typeof process.stderr, "write">>;

beforeEach(() => {
  vi.resetModules();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FREELANCE_DAEMON_PORT;
});

async function importPaths() {
  return import("../src/paths.js") as Promise<typeof import("../src/paths.js")>;
}

describe("DEFAULT_PORT", () => {
  it("defaults to 7433 when env var is not set", async () => {
    delete process.env.FREELANCE_DAEMON_PORT;
    const { DEFAULT_PORT } = await importPaths();
    expect(DEFAULT_PORT).toBe(7433);
  });

  it("parses valid port from env var", async () => {
    process.env.FREELANCE_DAEMON_PORT = "8080";
    const { DEFAULT_PORT } = await importPaths();
    expect(DEFAULT_PORT).toBe(8080);
  });

  it("warns and falls back for NaN port", async () => {
    process.env.FREELANCE_DAEMON_PORT = "abc";
    const { DEFAULT_PORT } = await importPaths();
    expect(DEFAULT_PORT).toBe(7433);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('FREELANCE_DAEMON_PORT="abc"'));
  });

  it("warns and falls back for port < 1", async () => {
    process.env.FREELANCE_DAEMON_PORT = "0";
    const { DEFAULT_PORT } = await importPaths();
    expect(DEFAULT_PORT).toBe(7433);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not a valid port"));
  });

  it("warns and falls back for port > 65535", async () => {
    process.env.FREELANCE_DAEMON_PORT = "70000";
    const { DEFAULT_PORT } = await importPaths();
    expect(DEFAULT_PORT).toBe(7433);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not a valid port"));
  });
});

describe("getPidFilePath", () => {
  it("returns a path ending with daemon.pid", async () => {
    const { getPidFilePath } = await importPaths();
    expect(getPidFilePath()).toMatch(/daemon\.pid$/);
  });
});

describe("constants", () => {
  it("exports FREELANCE_DIR and TRAVERSALS_DIR", async () => {
    const { FREELANCE_DIR, TRAVERSALS_DIR } = await importPaths();
    expect(FREELANCE_DIR).toBe(".freelance");
    expect(TRAVERSALS_DIR).toContain(".freelance");
    expect(TRAVERSALS_DIR).toContain("traversals");
  });
});
