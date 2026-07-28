/**
 * Re-exports ts-mls (RFC 9420). App code targets a single MLS import surface;
 * the SDK consumes ts-mls directly rather than re-branding its types
 * (design decision #1: consume, do not encapsulate).
 */
export * from "ts-mls";
