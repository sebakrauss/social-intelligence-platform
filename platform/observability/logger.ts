/**
 * Vendor-neutral structured logger (TA §42). Emits one JSON line per event through a sink.
 * Every record passes through the allowlist sanitizer, so callers can't log content they
 * shouldn't, even by accident. Error tracking and log-store vendors stay VALIDATE (TA-Q-08);
 * a vendor sink can be added later without changing call sites.
 */
import { sanitizeLogRecord, type LogFields, type LogLevel, type LogRecord } from "./log-record";

export type LogSink = (line: string) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose records include `fields` by default (e.g. module, correlationId, workspaceId). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly environment?: string;
  readonly now?: () => Date;
  readonly minLevel?: LogLevel;
  readonly base?: LogFields;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export function serializeLogRecord(record: LogRecord): string {
  return JSON.stringify(record);
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const minLevel = LEVEL_ORDER[options.minLevel ?? "info"];
  const base: LogFields = options.base ?? {};

  const emit = (level: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (LEVEL_ORDER[level] < minLevel) {
      return;
    }
    const record = sanitizeLogRecord({
      level,
      event,
      fields: { ...base, ...fields },
      timestamp: now().toISOString(),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    options.sink(serializeLogRecord(record));
  };

  return {
    debug: (event, fields) => { emit("debug", event, fields); },
    info: (event, fields) => { emit("info", event, fields); },
    warn: (event, fields) => { emit("warn", event, fields); },
    error: (event, fields) => { emit("error", event, fields); },
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
