import type { LogSink } from "./logger";

/** Writes JSON lines to stdout. The only place in the codebase allowed to use the console for logging. */
export const stdoutSink: LogSink = (line) => {
  console.log(line);
};
