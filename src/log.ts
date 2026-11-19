import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

const ts = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (...a: unknown[]) => console.log(`[${ts()}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${ts()}] WARN`, ...a),
  error: (...a: unknown[]) => console.error(`[${ts()}] ERROR`, ...a),
  debug: (...a: unknown[]) => {
    if (process.env.DEBUG) console.log(`[${ts()}] dbg`, ...a);
  },
};

/** Append a JSON line to data/<file>.jsonl — signals, trades, etc. */
export function record(file: string, obj: Record<string, unknown>) {
  const line = JSON.stringify({ t: Date.now(), ...obj }, (_k, v) => (v instanceof Set ? [...v] : v));
  fs.appendFileSync(path.join(config.dataDir, `${file}.jsonl`), line + "\n");
}
