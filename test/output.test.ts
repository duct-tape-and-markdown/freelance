import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debug, homeDir, setCli } from "../src/cli/output.js";

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCli({ json: false, quiet: false, verbose: false, noColor: false });
});

describe("debug", () => {
  it("writes to stderr when verbose is true and quiet is false", () => {
    setCli({ verbose: true, quiet: false });
    debug("test message");
    expect(process.stderr.write).toHaveBeenCalledWith("test message\n");
  });

  it("does not write when verbose is false", () => {
    setCli({ verbose: false, quiet: false });
    debug("test message");
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it("does not write when quiet is true even if verbose", () => {
    setCli({ verbose: true, quiet: true });
    debug("test message");
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
});

describe("homeDir", () => {
  it("throws when neither HOME nor USERPROFILE is set", () => {
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    expect(() => homeDir()).toThrow("Could not determine home directory");

    if (origHome) process.env.HOME = origHome;
    if (origProfile) process.env.USERPROFILE = origProfile;
  });
});
