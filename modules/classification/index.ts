/**
 * Public API of the classification module (TA §7.1: Classification Assessment, Accepted Interpretation, Language
 * Assessment, Protection Evaluation). Step H7-A1: the pure domain. Step H7-B: the deterministic runtime service and its
 * ports (persistence is composed by server/persistence/classification.ts). No gateway or model.
 */
export * from "./domain/taxonomy";
export * from "./domain/confidence";
export * from "./domain/language";
export * from "./domain/assessment";
export * from "./domain/precedence";
export * from "./domain/protection";
export * from "./domain/needs-review";
export * from "./domain/text-segments";
export * from "./domain/watch-terms";
export * from "./domain/signals";
export * from "./domain/understanding-input";
export * from "./domain/understanding-output";
export * from "./domain/value-inputs";
export * from "./domain/human-correction";
export * from "./domain/versions";
export * from "./application/ports";
export * from "./application/understand-deterministic";
