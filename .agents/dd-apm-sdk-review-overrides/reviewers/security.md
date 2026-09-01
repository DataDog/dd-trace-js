Override for `reviewers/security.md` (in the core skill folder) — read that file first, then this.

# Security — dd-trace-js specifics

## Language-specific footguns for dd-trace-js

- **Prototype pollution**: tag/config/header merging and payload-tagging code (`packages/dd-trace/src/tagger.js`, `payload-tagging/`, `config/index.js`) walks user-controlled keys — reject `__proto__`/`constructor`/`prototype`, prefer `Object.create(null)` maps and `Object.hasOwn`. Same hazard in instrumentation reading user request bodies/query into span tags.
- **Monkey-patching correctness is a security surface**: `packages/datadog-shimmer` + `datadog-instrumentations` wrappers must preserve `this`, arity, `name`, property descriptors, and must never swallow or alter user errors. A wrapper that changes semantics can defeat an app's own auth/validation logic.
- **require/module-resolution hazards**: `ritm.js`, `iitm.js`, `helpers/hook.js`, `require-package-json.js`, and `helpers/extract-package-and-module-path.js` load paths derived from the app; never `require()` a path derived from remote config or user input, and don't follow attacker-controllable filenames.
- **Remote config / RC payloads are untrusted input**: `packages/dd-trace/src/config/remote_config.js`, `appsec/remote_config.js`, `appsec/rc-products.js`, debugger probes (`src/debugger/`) — validate types and bounds, never `eval`/`new Function` on them.
- **ReDoS**: user-supplied or RC-supplied patterns compiled to RegExp (sampling rules `sampling_rule.js`, `config` glob/regex options, IAST redaction `benchmark/iast-evidence-redaction.js` paths, appsec rules) — bound input length, avoid nested quantifiers, prefer literal matching.
- **Unbounded buffers / memory DoS**: span tag values, payload tagging, appsec WAF report bodies, debugger snapshots, encoder buffers (`src/encode/*`, `msgpack/`) must cap size and depth; an unbounded accumulator in a per-request path is a remote OOM.
- **Secret leakage into telemetry**: never log or tag env vars, URLs with credentials, query strings, auth headers, or DB connection strings. Redaction paths: `appsec/iast` evidence redaction, `packages/dd-trace/src/log/`.
- **Crashing the user app is a security-grade failure**: AGENTS.md "Never crash user apps: Catch/log errors (`log.error()`/`log.warn()`), resume or disable plugin/subsystem".
- **Blocking/AppSec code paths** (`appsec/blocking.js`, `blocked_templates.js`, `rasp/`) must not reflect unescaped user input into responses.
- Child-process / command instrumentation (`datadog-instrumentations/src/child_process.js`) must not itself build shell strings from traced arguments.
