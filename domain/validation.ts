/**
 * Minimal server-side input validation (TA §10.6 step 4). Rejects unknown fields and wrong shapes
 * with the normalized INVALID_INPUT error. The error names a *declared* field key only, never an
 * unknown key or any submitted value. Deliberately small: no validation framework is needed yet.
 */
import { normalizeEmail } from "./email";
import { AppError } from "./errors";

export type Validator<T> = (value: unknown, field: string) => T;

type Shape = Readonly<Record<string, Validator<unknown>>>;
export type Infer<S extends Shape> = { readonly [K in keyof S]: ReturnType<S[K]> };

function invalid(field?: string): AppError<"INVALID_INPUT"> {
  return new AppError("INVALID_INPUT", field === undefined ? {} : { field });
}

export function text(options: { readonly min?: number; readonly max: number; readonly pattern?: RegExp }): Validator<string> {
  return (value, field) => {
    if (typeof value !== "string") throw invalid(field);
    const trimmed = value.trim();
    if (trimmed.length < (options.min ?? 1) || trimmed.length > options.max) throw invalid(field);
    if (options.pattern !== undefined && !options.pattern.test(trimmed)) throw invalid(field);
    return trimmed;
  };
}

export function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  return (value, field) => {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw invalid(field);
    return value as T;
  };
}

export function parsed<T>(parse: (value: unknown) => T | undefined): Validator<T> {
  return (value, field) => {
    const result = parse(value);
    if (result === undefined) throw invalid(field);
    return result;
  };
}

export function list<T>(item: Validator<T>, options: { readonly max: number }): Validator<readonly T[]> {
  return (value, field) => {
    if (!Array.isArray(value) || value.length > options.max) throw invalid(field);
    const items = value.map((entry: unknown) => item(entry, field));
    if (new Set(items).size !== items.length) throw invalid(field);
    return items;
  };
}

export function optional<T>(validator: Validator<T>): Validator<T | undefined> {
  return (value, field) => (value === undefined ? undefined : validator(value, field));
}

/** Validates a plain object against `shape`. Any key not in `shape` is rejected. */
export function object<S extends Shape>(shape: S): (input: unknown) => Infer<S> {
  return (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid();
    const record = input as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(shape, key)) throw invalid();
    }
    const result: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(shape)) {
      result[key] = validator(record[key], key);
    }
    return result as Infer<S>;
  };
}

/** Normalized (trimmed, lower-cased) email address; checked for shape only. */
export const email: Validator<string> = (value, field) => {
  const normalized = normalizeEmail(value);
  if (normalized === undefined) throw invalid(field);
  return normalized;
};
