#!/usr/bin/env node
import { handleRuntimeError } from "./cli/output.js";
import { program } from "./cli/program.js";

// Top-level catch: commander's `argParser` callbacks run *before* the
// action handler's try/catch, so an EngineError thrown from an argParser
// (e.g. INVALID_FLAG_VALUE on `--fields bogus`) would otherwise bubble
// as an uncaught exception with exit 1. Route those through
// `handleRuntimeError` so they surface as the unified JSON envelope +
// the semantic exit code for their category.
program.parseAsync(process.argv).catch((err) => {
  handleRuntimeError(err);
});
