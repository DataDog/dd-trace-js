---
name: code-review
description: >
  Review a PR or code change against the dd-trace-js codebase standards. Use when asked to review
  code, check a PR before submitting, or identify issues across architecture, correctness, style,
  tests, and observability. Outputs categorised comments with severity labels and fix suggestions.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, WebFetch
---

You are performing a thorough code review of a dd-trace-js change. Use the checklist in
[review-checklist.md](review-checklist.md) to guide your analysis. Group your output by category,
label each comment by severity, and include a concrete fix suggestion for every issue raised.

## Input

`$ARGUMENTS` — a PR number, file path, diff, or description of the change to review.

If a PR number is given, use the GitHub API or WebFetch to read the diff and description:
- `https://github.com/DataDog/dd-trace-js/pull/<PR_NUMBER>/files`
- `https://api.github.com/repos/DataDog/dd-trace-js/pulls/<PR_NUMBER>/files`

If a file path is given, read the file and review it in context.

## Output Format

```
## Architecture & Design

### [BLOCKER | CONCERN | NIT] Short title
**File:** path/to/file.js:line
**Comment:** Specific feedback.
**Suggested fix:** Concrete code or approach to address it.

---

## Performance & Memory

### [BLOCKER | CONCERN | NIT] Short title
...
```

Repeat for each applicable category:
- Architecture & Design
- Performance & Memory
- Configuration System
- Async & Correctness
- Test Quality
- Code Style & Readability
- Observability & Logging
- Documentation & PR Hygiene

Omit any category that has no findings.

Label each comment:
- **BLOCKER** — must be fixed before merge
- **CONCERN** — notable issue worth discussing; likely approved conditional on author's response
- **NIT** — style/readability preference; non-blocking

At the end, add a `## Summary` section with an overall verdict:
- "LGTM" — no significant issues
- "LGTM with caveats" — concerns worth tracking but not blocking
- "CHANGES_REQUESTED" — one or more BLOCKERs present

---

## Review Checklist (read before reviewing)

See [review-checklist.md](review-checklist.md) for the full reference.

### Architecture & Design (most likely BLOCKER)
- Does the code bypass an existing designed mechanism (Diagnostics Channel, store bindings,
  `runStores`/`bindStore`, propagator interfaces)?
- Does it call internal APIs directly when a public/designed interface exists?
- Does it mix cross-cutting concerns (e.g., tying baggage to span context when the systems are
  intentionally separate)?
- Are WeakRefs used for cleanup that should go through proper store lifecycle?
- Is a helper function that only wraps another function with no transformation?
- Are symbols re-exported without modification?
- Is a function called in only one place that could be inlined?

### Performance & Memory (BLOCKER or CONCERN)
- Is there a risk of unbounded growth (streams, maps, listeners)?
- Are there unnecessary allocations in a hot path?
- If the PR claims a performance improvement, is there a benchmark?
- Is a Map keyed by objects (e.g., request objects, contexts) without guaranteed cleanup? Prefer WeakMap.
- Is timer-based cleanup used where it could cause sawtooth memory growth?
- Is an expensive computation created eagerly when it is only needed conditionally?

### Configuration System (BLOCKER)
- Is a new environment variable defined outside of `packages/dd-trace/src/config/index.js`?
- Is it missing from `supported-configurations.json`?
- Does it lack telemetry registration?
- Is the config file modified in a way that looks corrupted (e.g., rebase artifact)?
- Is a new boolean toggle being added that tightly mirrors an existing option?

### Async & Correctness (BLOCKER or CONCERN)
- Are two `await` calls in sequence where rejection of the first would leave the second unhandled?
  Use `Promise.all([...])` instead.
- Does code rely on NaN being falsy? Be explicit.
- Is there an unnecessary fallback that silently changes existing behaviour (e.g., `undefined` → `null`)?
- Does a Node.js built-in API exist that avoids a custom workaround?

### Test Quality (BLOCKER or CONCERN)
- Are plugin tests mocking tracer internals instead of reconfiguring via public API?
- Is `afterEach` cleanup missing? (Reset after an assertion = unstable test)
- Does the test spy on implementation details that don't need to be tested?
- Does a bug fix lack a test to verify it?
- Does one `it` block depend on side effects from a previous `it` block?
- Is shared mutable state missing `beforeEach`/`afterEach` setup/teardown?
- Is there a redundant existence check immediately before a value assertion? Assert the value directly.
- Are there copy-paste mistakes (duplicate assertions on the same property)?
- Could multiple `assert.strictEqual` calls be combined into one `assert.deepStrictEqual` or
  `assertObjectContains`?

### Code Style & Readability (NIT)
- Are `_underscore` prefixed properties used on a class where `#private` fields would work?
- Are properties conditionally added to an object after construction, causing V8 shape changes?
- Are static getters used instead of static class members? Use static properties.
- Do non-class symbols have a leading capital letter? They shouldn't.
- Are `require()` calls inside functions or try/catch blocks when they could be at the top of the file?
- Is a try/catch wrapping more code than what can actually throw? Prefer narrow try/catch.
- Are bitwise or type-coercion tricks used that are hard to follow at a glance?
- Is there commented-out code that should be removed?

### Observability & Logging (CONCERN or NIT)
- Is any existing log/debug output being removed without a replacement?
- Is there a code path where a feature could silently fail without any log?
- Should a `catch` block log the error?

### Documentation & PR Hygiene (NIT or CONCERN)
- Are there unrelated changes that should be in a separate PR?
- Is a new CI workflow justified, or could it go in an existing one?
- Is retry logic too broad (retrying non-flaky commands)?
- Does the PR add new public API surface area that needs a semver label update?
- Does AGENTS.md use fenced code blocks where inline code would save tokens?
- Does AGENTS.md contain inaccurate, vague, or contradictory claims?
- Does moving a file to a new directory change a user-facing `require()` path?
