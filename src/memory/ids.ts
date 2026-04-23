/** UUID + ISO timestamp primitives shared across memory write paths. */

import crypto from "node:crypto";

export function generateId(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}
