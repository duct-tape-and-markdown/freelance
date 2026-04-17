import { afterEach, describe, expect, it, vi } from "vitest";
import { startParentHeartbeat } from "../src/server.js";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("startParentHeartbeat", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    if (stop) stop();
    stop = undefined;
    vi.restoreAllMocks();
  });

  it("does nothing when ppid <= 1 (nothing to watch)", async () => {
    const onExit = vi.fn();
    const stop1 = startParentHeartbeat({ ppid: 0, onExit, intervalMs: 10 });
    const stop2 = startParentHeartbeat({ ppid: 1, onExit, intervalMs: 10 });
    await tick(60);
    stop1();
    stop2();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("does not fire when the original parent is alive and ppid is stable", async () => {
    const onExit = vi.fn();
    stop = startParentHeartbeat({ ppid: process.ppid, onExit, intervalMs: 10 });
    await tick(60);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("fires 'parent-exited' when the existence probe throws ESRCH", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    });
    const onExit = vi.fn();
    stop = startParentHeartbeat({ ppid: process.ppid, onExit, intervalMs: 10 });
    await tick(60);
    expect(onExit).toHaveBeenCalledWith("parent-exited");
  });

  it("ignores non-ESRCH kill errors (e.g. EPERM)", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    });
    const onExit = vi.fn();
    stop = startParentHeartbeat({ ppid: process.ppid, onExit, intervalMs: 10 });
    await tick(60);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("fires 'parent-reparented' when process.ppid drifts from the snapshot", async () => {
    const ppidDesc = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", { get: () => 1, configurable: true });
    try {
      const onExit = vi.fn();
      stop = startParentHeartbeat({ ppid: 99999, onExit, intervalMs: 10 });
      await tick(60);
      expect(onExit).toHaveBeenCalledWith("parent-reparented");
    } finally {
      if (ppidDesc) Object.defineProperty(process, "ppid", ppidDesc);
    }
  });

  it("prefers drift detection over the kill probe (no kill call on drift)", async () => {
    const killSpy = vi.spyOn(process, "kill");
    const ppidDesc = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", { get: () => 1, configurable: true });
    try {
      const onExit = vi.fn();
      stop = startParentHeartbeat({ ppid: 99999, onExit, intervalMs: 10 });
      await tick(60);
      expect(onExit).toHaveBeenCalledWith("parent-reparented");
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      if (ppidDesc) Object.defineProperty(process, "ppid", ppidDesc);
    }
  });
});
