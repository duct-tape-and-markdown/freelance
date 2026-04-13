#!/usr/bin/env node
import { program } from "./cli/program.js";

program.parseAsync(process.argv);
