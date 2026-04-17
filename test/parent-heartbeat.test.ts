import { afterEach, describe, expect, it, vi } from "vitest";
import { startParentHeartbeat } from "../src/server.js";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("startParentHeartbeat", () => {
  const timers: NodeJS.Timeout[] = [];

  afterEach(() => {
    while (timers.length) {
      const t = timers.pop();
      if (t) clearInterval(t);
    }
    vi.restoreAllMocks();
  });

  it("returns undefined when initialPpid <= 1 (nothing to watch)", () => {
    expect(startParentHeartbeat(0, () => {})).toBeUndefined();
    expect(startParentHeartbeat(1, () => {})).toBeUndefined();
  });

  it("does not fire when the original parent is alive and ppid is stable", async () => {
    const onExit = vi.fn();
    const timer = startParentHeartbeat(process.ppid, onExit, 10);
    if (timer) timers.push(timer);
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
    const timer = startParentHeartbeat(process.ppid, onExit, 10);
    if (timer) timers.push(timer);
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
    const timer = startParentHeartbeat(process.ppid, onExit, 10);
    if (timer) timers.push(timer);
    await tick(60);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("fires 'parent-reparented' when process.ppid drifts from the snapshot", async () => {
    const ppidDesc = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", {
      get: () => 1,
      configurable: true,
    });
    try {
      const onExit = vi.fn();
      const timer = startParentHeartbeat(99999, onExit, 10);
      if (timer) timers.push(timer);
      await tick(60);
      expect(onExit).toHaveBeenCalledWith("parent-reparented");
    } finally {
      if (ppidDesc) Object.defineProperty(process, "ppid", ppidDesc);
    }
  });

  it("prefers drift detection over the kill probe (no kill call on drift)", async () => {
    const killSpy = vi.spyOn(process, "kill");
    const ppidDesc = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", {
      get: () => 1,
      configurable: true,
    });
    try {
      const onExit = vi.fn();
      const timer = startParentHeartbeat(99999, onExit, 10);
      if (timer) timers.push(timer);
      await tick(60);
      expect(onExit).toHaveBeenCalledWith("parent-reparented");
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      if (ppidDesc) Object.defineProperty(process, "ppid", ppidDesc);
    }
  });
});
