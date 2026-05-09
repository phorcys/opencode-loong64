// OpenTUI core contains top-level async native initialization. Load it before
// the CLI command graph so split chunks that extend OpenTUI classes do not
// evaluate while the core module is still suspended.
await import("@opentui/core")
await import("./index-main")
