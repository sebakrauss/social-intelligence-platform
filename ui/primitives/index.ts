/**
 * Product UI primitives (UI-2). Presentational server components over the UI-1 foundations: no data access, no
 * authorization, no client JavaScript. Every text they show arrives already translated from the server page.
 */
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./button";
export { DataTag, type DataTagProps, type DataTagTone } from "./data-tag";
export { Disclosure, type DisclosureProps } from "./disclosure";
export { Field, type FieldProps } from "./field";
export { NOTICE_ICON, Notice, type NoticeProps, type NoticeTone } from "./notice";
export { OriginMark, PLATFORM_MONOGRAM, type OriginMarkProps, type OriginPlatform } from "./origin-mark";
export { StatePill, type StatePillProps, type StateTone } from "./state-pill";
export { TextLink, type TextLinkProps } from "./text-link";
