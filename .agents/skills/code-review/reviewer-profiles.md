# Reviewer Profiles: rochdev, BridgeAR, watson, bengl, and tlhunter

This document summarizes the review styles and priorities of the five primary reviewers on the dd-trace-js repository, based on analysis of their actual review comments across 30+ PRs each.

---

## rochdev

rochdev is the primary maintainer/architect. Reviews span architecture, CI, performance, correctness, and code style. Tends to write concise but substantive review bodies, and often leaves a single high-signal comment per PR.

### Communication Style

- Terse to moderate. Often a one-line approval ("LGTM!") or short paragraph.
- Will add a short caveat or observation even on approvals: _"Worth noting that this will only send to stderr by default. When a custom logger is configured, it will go to wherever that logger is configured... but I'm assuming this is intended. LGTM!"_
- Uses "LGTM" and "LGTM!" routinely for clean approvals.
- "Not a blocker" language when noting issues that can be addressed later.
- Will explicitly block ("CHANGES_REQUESTED") when architectural concerns are serious.

### What He Cares About Most

#### 1. Architectural Correctness Over Quick Fixes
rochdev frequently pushes back when a fix or shortcut bypasses the intended system design, even if the code works. He expects you to understand the existing architecture and work within it.

- On a memory-leak fix using `WeakRef`: _"This might actually introduce a memory leak, along with a performance degradation. We've used `WeakRef` in the past for a few things and it ended up holding things in memory for longer. Instead we should update the HTTP integration to properly use `runStores` and `bindStore` so that the storage itself handles cleaning up."_
- On OpenTelemetry baggage syncing with the legacy API: _"The whole reason for the new API was because the global baggage is disconnected from the concept of traces and can't be tied to it, so I'm not sure why we're touching the legacy API. They operate on 2 completely different contextual hierarchies, tying them together doesn't make sense."_
- On calling `sample()` directly in a span: _"There is already a mechanism in place to sample before propagation, so we could use the same mechanism instead of calling `sample` directly."_ and _"A propagator is meant to inject the tracing context into a carrier without requiring knowledge of the underlying internals."_
- On using a special helper to sync DSM state: _"Such a helper should not be needed if we use Diagnostics Channel properly. There should either be a completely separate store or the syncing should happen implicitly."_

#### 2. Performance and Memory Safety
rochdev is acutely aware that dd-trace runs in application hot paths. He notices potential allocations, leaks, and inefficiencies.

- Flags edge cases where streams could pile up without bounds: _"This could create an edge case where streams are piling up forever. There needs to be handling for their sizes too."_
- Flags retrying all commands when only yarn install should be retried: _"I just realized that this retries _everything_, which shouldn't be the case. The only command that should be able to be flaky is installing from the registry, retrying anything else could hide real issues."_

#### 3. Test Quality and Correctness
He expects tests to cover real behavior, not just pass superficially. He is skeptical of implementation details in tests and emphasizes isolation.

- On mocking internals in plugin tests: _"Plugin tests are integration tests, mocking internals should be avoided whenever possible. Can the tracer be reconfigured with different rates instead?"_
- On a spy being used unnecessarily: _"This spy is not needed, only the behaviour needs to be tested."_
- On cleanup in wrong place: _"Resetting should be done in an `afterEach` block and not after an expectation. This is because expectations may never run or an error may be thrown beforehand and then the reset would never happen."_

#### 4. Separation of Concerns / PR Scope
He notices when unrelated changes are mixed in and asks for them to be separated.

- _"These changes are a nice to have, but unrelated to this PR and in the future it would be best to make those unrelated changes in another PR to avoid unnecessary noise."_

#### 5. CI/Infrastructure Hygiene
rochdev owns a lot of CI. He cares about:
- Not duplicating configuration: _"Why the new workflow? Why can't we just add this to an existing workflow like 'Project'?"_
- Avoiding noise in debug output: _"Could we limit the logging to entries that are not successful? It would otherwise be very verbose."_
- Security of automation (e.g., dependabot workflows): _"My worry is what if dependabot opens a PR, then a malicious user adds a commit, and then dependabot updates the PR? In that scenario, the PR would be auto-approved by automation without ever validating the changes from the user."_

#### 6. Performance Benchmarks for Performance PRs
When a PR claims a performance improvement, rochdev expects evidence: _"If this is addressing a performance issue, can you please add a benchmark that highlights the improvement?"_

### Patterns He Looks For / Against

| Pattern | His Stance |
|---|---|
| WeakRef for cleanup | Negative — has caused leaks before; prefer proper store bindings |
| Direct internal API calls instead of going through designed interfaces | Negative — always route through the correct abstraction layer |
| `WeakRef`, event listener leaks | Flags as potential leaks |
| Unrelated changes in a PR | Asks to split out |
| Mocking tracer internals in plugin integration tests | Negative — reconfigure via public API instead |
| `afterEach` cleanup omissions | Flags as potential test instability |
| Diagnostics Channel misuse (publish vs runStores) | Blocks — correctness critical |
| Missing benchmarks for perf PRs | Asks to add before merging |

---

## BridgeAR

BridgeAR (Ruben Bridgewater) is a Node.js core contributor. His reviews reflect deep Node.js internals knowledge, strong opinions on code style, and a pragmatic-but-principled approach to API design. He is more verbose than rochdev and often explains the "why" behind suggestions.

### Communication Style

- Moderate to verbose. Frequently explains rationale, not just what to change.
- Uses "Nit:" prefix liberally for non-blocking style suggestions.
- "RSLGTM" (rubber stamp LGTM) for changes outside his expertise area.
- "LGTM, just left a few nits" is his most common approval message.
- Will dismiss his own review when the PR improves even if not fully resolved: _"Ignoring undefined does not seem correct by claude. This nevertheless improves a lot, so LGTM."_
- Will explicitly call out when he's uncertain about business logic: _"I can not say much about the business requirements here."_
- Positive and encouraging when work is done well: _"Nice, reducing the runtime is always great!"_, _"thank you for the nice improvement!"_

### What He Cares About Most

#### 1. Modern JavaScript / Class Field Privacy
BridgeAR strongly advocates for using ES private class fields (`#field`) instead of underscore-prefixed conventions (`_field`). This is probably his most consistent feedback.

- _"Please use actual private properties instead of underscores :)"_ (with code suggestion converting `_nameToId` to `#nameToId`)
- _"Nit: are these underscored properties really meant as 'internally private'? [...] I am just commenting about it because it would be great to make truly internal methods truly private and keep others accessible."_
- _"I understand why it was used but we are currently moving away from that in most code. Thus, when we touch something, it would be great to change it as well."_

#### 2. Configuration System Discipline
BridgeAR is meticulous about the configuration infrastructure. He insists that environment variables be registered in the central config, get telemetry, and are documented in `supported-configurations.json`.

- _"Please move this into the config file, since it would only receive the proper telemetry when being in there right now."_
- _"Please add the configuration name as well (it will soon be renamed to `internalPropertyName` in case it is not exposed as option, but for now using the `configurationNames` would be sufficient)."_
- _"This seems like it is the wrong spot. It would be best to be placed inside of the environment part."_

#### 3. Promise/Async Correctness
He catches subtle async bugs, especially unhandled rejections.

- _"If assertMessageReceived would reject before axios.request resolves (due to potential any side effects), this would cause an unhandled rejection. I would therefore use `Promise.all()` here."_

#### 4. Performance and Object Shape Stability
As a Node.js internals expert, BridgeAR cares about V8 object shape stability and avoiding unnecessary allocations.

- _"Ideally we create an object before and add `host` as property only if hostname is available. I guess loading os here and reading it lazy is fine, since we should normally just construct this once."_
- _"I personally like to prevent overhead and have shapes staying stable."_
- On a `splice` instead of conditional copy: _"Do we need to copy the frames for `allFrames`? Would it not be fine to just return `callSiteFrames`?"_

#### 5. Test Helper Semantics and Correctness
BridgeAR maintains the `assertObjectContains` helper and is very precise about its semantics. He blocked a large refactor that broke the semantics of the helper:

- _"This change makes most tests pass because of our fallback for asymmetric matchers. That is however changing the semantics in a way that is not intended."_
- _"This is still incorrect and it must be the original check. Otherwise we have different semantics between partialDeepStrictEqual and our helper."_
- On transformation edge cases: _"This is not a valid transformation. Payload is actually an array, not a plain object."_
- Prefers combining multiple assertions into one: _"Ideally be combined to a single call"_, _"Single call?"_, _"We could use assertFirstTraceSpan directly. That would be a bit nicer."_

#### 6. Code Readability and Explicitness
He prefers explicit, readable code over clever shorthand.

- On a bitwise coercion trick: _"It is also more difficult to process in my opinion. We have to know that the OR is of higher precedence and that this works due to being coerced to NaN which is falsy. The brackets are straight forward to understand."_
- On explicit `undefined` return: _"I think this would be a case where explicitly returning `undefined` makes the intent clearer."_
- On test names: _"Nit, I'd probably reword this, as that's actually only a side effect. [...] that's the real problem that the test is testing for."_
- On naming: _"I think it would be better to use `push_to_test_optimization`. For someone who might not be familiar with this, it is likely that they have to briefly think what it stands for instead of knowing right away with the full name."_

#### 7. Early Exits and Guard Clause Optimization
He prefers moving guard conditions earlier to avoid unnecessary work.

- _"Ideally, this is moved up into the `!filename` if statement with an OR. That way there is no additional work done while checking for that."_

#### 8. Logging and Observability
BridgeAR wants diagnostic information to be preserved and surfaced at the right time.

- _"What about logging these at the end in case of a failure? I think that would be very helpful. It is otherwise unclear what is happening."_
- _"Since we already lowered the number of requests and we have not run into the limit right now, I think it's best to include that before merging. It otherwise removes information that was formerly there."_
- On `assert.ok(rewriter)` vs a strict equality check: _"Could we change this to `assert.ok(rewriter)`? That way it is a safer check."_

### Patterns He Looks For / Against

| Pattern | His Stance |
|---|---|
| `_underscore` private fields on classes | Negative — use `#private` fields instead |
| Environment variables defined outside config system | Blocks — insist on proper registration in `config/index.js` |
| Unhandled rejection risk (parallel awaits without `Promise.all`) | Flags as correctness bug |
| Clever type coercions (NaN-falsy tricks, implicit type casts) | Negative — prefer explicit/readable |
| Multiple sequential assert calls that could be one call | Nit — combine into single `assertObjectContains`/`assertFirstTraceSpan` |
| Unnecessary object copies or frame splices | Nit — simplify if semantically equivalent |
| Log/debug information removed without replacement | Blocks or flags |
| New env vars not registered in the config telemetry system | Blocks |
| `assert.doesNotThrow()` | Negative — use `no-restricted-syntax` ESLint rule instead |
| Commented-out code left in PR | Flags for removal |
| Guard conditions placed too late (unnecessary early work) | Nit — move guards up |

---

## watson (Thomas Watson)

watson is a **warm but technically precise** reviewer. He uses emoji freely (👍, 🤷, ☺️, 💯, 😂), often compliments good work, and softens criticism with prefixes like "Nit:" or "Non-blocking nit:" to distinguish blocking concerns from style preferences. He asks clarifying questions rather than simply stating what is wrong. He is one of the most active reviewers on infrastructure/CI, AGENTS.md, test tooling, and the Dynamic Instrumentation (debugger) subsystem, which he maintains as primary owner.

### Communication Style

- Warm, emoji-heavy, uses "Nit:" and "Non-blocking nit:" consistently to flag non-blockers.
- Asks clarifying questions: "Not sure I understand this bullet?" rather than just stating the fix.
- Approves with specific praise: "Great work 💯", "Good catch, and thank you for contributing ☺️"
- Will approve while noting caveats: "I would prefer a few minor things to be cleaned up, but since the holidays are coming up, I will not want to be a blocker, so I'll approve..."
- Rarely uses CHANGES_REQUESTED — only when DX is materially harmed.

### What He Cares About Most

#### 1. Test assertion correctness and minimalism

Watson objects to redundant existence checks before value assertions, and prefers standard `node:assert` methods over custom assertion helpers.

- _"Nit: I usually don't add extra asserts to validate that a given property is present, if I can assert its value instead. Especially if you as here do that on the very next line."_
- _"I think `exists` is better replaced by: `assert.notEqual(testSessionEvent.content.meta[ERROR_MESSAGE], null)`"_
- _"Can we move this function to a helper and use it elsewhere? I'm sure we have similar needs in other tests"_
- _"Copy paste mistake? It's also set above"_

#### 2. Code logic and correctness

He reads logic carefully and flags semantic issues, incorrect fallbacks, and unnecessary guard clauses.

- _"That's not identical. If `vulnerabilitiesCount.get(v.type)` is `undefined` we need the fallback to `0`."_
- _"That's only because `NaN` is falsy. I don't think relying on that is such a good idea. Our TS checker would definitely not allow it."_
- _"Since it didn't return `null` before, but `undefined`, I'd argue that there's a bigger risk making this change vs just removing the entire `default` statement."_
- _"This seems like a mistake — The `unref` function was added in Node.js v0.9.1, so why can't we just: `this._timer.unref()`"_

#### 3. AGENTS.md / documentation quality

Watson drives AGENTS.md content and reviews every change to it line-by-line. He is opinionated about conciseness (to save agent tokens) and accuracy.

- _"Non-blocking nit: I'm not a fan of the word 'consistency' as it's very vague. I'd prefer something like `test:verify-exercised`"_
- _"Consider merging these two bullets as the second one defies the first"_
- _"I fear using code blocks might be wasting tokens. I prefer inline blocks and bullet lists"_
- _"Not sure I understand this bullet?"_

#### 4. CI / workflow correctness and developer experience

- _"This would mean, that if a test is flaky and we'll have to re-run all-green after the flaky test has passed, we'd have to wait delay-minutes. For me unfortunately that's a blocker"_ (CHANGES_REQUESTED)
- _"Would it make sense to contribute this upstream?"_

#### 5. Performance — lazy evaluation and allocation avoidance

- _"No need to calculate the preview unless it's needed"_ — prefers lazy computation gated behind the condition check.
- Avoids unnecessary object creation in conditional paths.

### Patterns He Looks For / Against

| Pattern | His Stance |
|---|---|
| Existence check before value assertion | Negative — assert the value directly |
| NaN-falsy tricks or implicit type coercion | Negative — TS would reject it; be explicit |
| Code blocks in AGENTS.md where inline code would do | Negative — token waste |
| CI delays added as "safety" but blocking developer flow | Blocks when it harms developer experience |
| Lazy vs. eager computation in non-hot setup code | Prefers lazy |
| Redundant assertions | Asks to remove |
| Vague documentation language | Asks for concrete examples or better names |

---

## bengl (Bryan English)

bengl is a **technically rigorous, architecturally-minded** reviewer. He writes concise, dense comments that cut straight to the conceptual issue. He uses minimal emoji or softening language — his comments are direct and assume the reader understands the codebase. He frequently challenges architectural decisions, questions the purpose of abstractions, and asks whether simpler approaches exist. He primarily reviews: instrumentation hooks, plugin architecture, ESM/CJS interop, shimmer, test infrastructure, remote config, and general refactors.

### Communication Style

- Terse and direct. No emoji, no softening language.
- Rhetorical questions: "What's the value in all these re-exports?"
- Will name the conceptual problem bluntly: "Things that aren't classes shouldn't have a leading capital letter."
- Bare approvals: empty body APPROVED, or "LGTM once CI and lint is fixed".
- Will express enthusiasm on good work while still blocking: "Good start. Can't wait to see the corresponding PR against Orchestrion-JS!"

### What He Cares About Most

#### 1. Unnecessary abstractions / over-engineering

bengl regularly flags helpers, wrappers, and re-exports that add complexity without benefit.

- _"What's the value in all these re-exports? If we're not modifying them, it just adds to confusion when reading a test file."_
- _"Why bother with this, rather than just letting the caller call `after` directly, for clarity?"_
- _"This function is only ever called on line 12 of this file, so you might as well in-line it for clarity."_
- _"The fact that both this file and `integration-tests/helpers/index.js` both exist is confusing. Can you consolidate them?"_
- _"This test API is confusing. Can we not just use `node:assert` functions?"_

#### 2. Simplification and reducing duplication

He spots patterns that can be collapsed: redundant loops, unnecessary promise wrappers, missing early exits.

- _"Rather than a whole new promise object, can't you just return or throw in the `then` handler?"_
- _"Instead of calling `limitDepth()` on what this function returns, you can just call it on every item you add to `extractedQueries`. That way you don't have to loop through them twice."_
- _"This is the same code as the previous if-block so you can just put them together with `||`."_
- _"No need for the `Promise` constructor here. Just use `node:timers/promises`."_

#### 3. Naming conventions and code style

- _"Things that aren't classes shouldn't have a leading capital letter. This is not the only place in this PR where this happens."_
- _"None of these function names follow our coding style."_
- _"Here and throughout this PR, both a static getter and a static member are used. The static getter is a holdover from when static members weren't supported by the runtime. Today they are, so everything should be a static member."_
- _"We should stop using static accessors and just use static properties going forward."_

#### 4. Bug fixes must have tests

bengl explicitly blocks or calls out missing tests for bug fixes.

- _"A fixed bug needs a test to verify."_ (CHANGES_REQUESTED)

#### 5. Instrumentation / plugin architecture correctness

- _"In the start event, there's always an arguments property on the context. There's no need to check for its presence."_
- _"This is pretty repetitive. Can we not make this implicit via `addHooks`'s definition?"_

#### 6. AGENTS.md / documentation accuracy

- _"This section seems to be mostly a dupe of the `## Project Overview` section below."_
- _"Many tests are not mocha."_
- _"This should be clear that it's TS-compatible JSDoc, and not necessarily arbitrary JSDoc."_
- _"We should crash apps when we're not configured correctly? That seems wrong."_
- _"This line makes no sense... it's saying coverage should be driven down. This is wrong."_

#### 7. Semver implications of API changes

- _"This is a semver-minor change. Will update the label accordingly."_
- _"This adds new API surface area so it would need: (1) its own test, (2) a corresponding PR against dd-trace-api-js, (3) the appropriate changes in the dd-trace-api integration in this repo"_

### Patterns He Looks For / Against

| Pattern | His Stance |
|---|---|
| Static getters instead of static class members | Negative — use static properties |
| Abstractions (helpers, wrappers) that add no value | Asks to remove/inline |
| Bug fixed without a test | Blocks |
| Re-exporting symbols without modification | Asks to remove |
| Two test helper files doing similar things | Asks to consolidate |
| AGENTS.md containing contributing-guide content | Blocks — belongs in CONTRIBUTING.md |
| Semver-minor API surface changes | Flags and updates label |
| Unnecessary promise wrappers | Asks to simplify |
| Redundant loops over the same data | Asks to combine |

---

## tlhunter (Thomas Hunter II)

tlhunter is a **practical, architecture-aware** reviewer who balances code quality with pragmatism. He uses a mix of direct statements, rhetorical questions ("Is there a reason to...?", "Shouldn't this be...?"), and inline suggestion blocks. He often uses non-blocking qualifiers ("non-blocking nit", "I left some nit picks, up to you if you want to apply them") and is willing to approve or dismiss with outstanding nits. He primarily reviews: new integrations (plugins), data streams/DSM, websocket, process tags, bundler support, and configuration management.

### Communication Style

- Pragmatic mix of direct statements and rhetorical questions.
- Uses "non-blocking nit" and "up to you if you want to apply them" — approves with caveats freely.
- Willing to dismiss with outstanding nits when the core is sound.
- "Something very bad happened in this file" for corrupted config — otherwise mild tone.
- Will flag AI hallucinations explicitly: _"Looks like a hallucination..."_

### What He Cares About Most

#### 1. Test isolation: `it` blocks must be independently runnable

tlhunter insists that individual test cases be self-contained and not depend on side effects from previous tests.

- _"We try to make tests so that they're self contained. Like one should be able to isolate and only run one `it` block and have it pass (e.g. using `it.only`). But it looks like the second `it` depends on side effects from the first `it`. Can you throw the shared work into the `beforeEach` block? And to that end clear the records out in a new `afterEach`?"_
- _"Is this intentionally making the same request twice?"_

#### 2. Memory safety: Map vs. WeakMap

He consistently flags when a regular Map is used with object keys where a WeakMap would prevent memory leaks.

- _"Maps like these which correlate to user-operations (such as HTTP requests) are scary because they can cause memory leaks whenever we don't clean up properly. For that reason we try to use a WeakMap instead... However it only works when the key is an object and your Map is using a string as a key."_
- _"But I'm pretty concerned about using a timer like this for cleanup since these types of solutions can often cause memory leaks. E.g. with a 60 second timer there could be a saw tooth memory increase with a 60 second period."_

#### 3. `supported-configurations.json` hygiene

tlhunter carefully validates configuration file changes and flags corruption or incorrect entries.

- _"Something very bad happened in this file... Maybe from a rebase issue?"_ (CHANGES_REQUESTED)
- _"The supported configurations file needs to be fixed. Does it need to be changed at all? I would only think so if this integration is released as experimental."_
- _"It looks like the value has never existed before? If so I would think A would be the anticipated value."_

#### 4. Unnecessary configuration options

He consistently pushes back against adding new configuration toggles when they are not needed.

- _"There should not be an additional configuration. If WS is enabled then span pointers is enabled."_

#### 5. Catching AI-generated code errors

tlhunter explicitly calls out when AI-generated code introduces framework-specific hallucinations.

- _"Looks like a hallucination... `keepNames` is an ESBuild concept (which this code is trained on). Webpack has a `keep_classnames` setting but no `keepNames`."_

#### 6. Logging for observability

He flags missing log statements when operations can fail silently.

- _"Let's add a log here as well. Otherwise it would be difficult to diagnose if the feature isn't working for customers who expect it to."_
- _"This is a good candidate for logging."_
- _"This might be fine but we should definitely log what happens"_ — with `if (err.code === 'MODULE_NOT_FOUND')` as an example.

#### 7. Code clarity and require/import hoisting

- _"This require call should be hoisted to the top of the file"_
- _"It looks like it's not the requiring of the file that can fail but only the class instantiation. For that reason let's hoist the require out of the try/catch. It's better to make try/catch super specific IMO."_

#### 8. try/catch specificity

- _"It's better to make try/catch super specific IMO."_
- _"What part of this is expected to throw?"_

#### 9. User-facing file layout vs. internal structure

- _"The location of this file is ultimately the way that the user consumes it... Moving it to a bundlers/ directory makes the structure cleaner for us project devs but dirtier for the users who would need to do `require('dd-trace/bundlers/webpack')`."_

### Patterns He Looks For / Against

| Pattern | His Stance |
|---|---|
| `it` blocks that share mutable state with adjacent tests | Blocks or asks for `beforeEach`/`afterEach` |
| Map with object keys where cleanup is not guaranteed | Asks to use WeakMap |
| Timer-based cleanup (e.g. 60s intervals) | Concerned — flags memory leak risk |
| `supported-configurations.json` modified incorrectly or corruptly | Blocks |
| Adding new config toggles without justification | Asks to remove the option |
| AI-generated code with framework-specific hallucinations | Flags explicitly |
| requires/imports not at the top of the file | Asks to hoist |
| Broad try/catch around code that mostly cannot throw | Asks to narrow |
| Missing logs when a feature can silently fail | Asks to add |
| Moving files to new paths that change user-facing require paths | Flags — user DX matters more than internal structure |

---

## Summary Comparison

| Dimension | rochdev | BridgeAR | watson | bengl | tlhunter |
|---|---|---|---|---|---|
| Primary focus | Architecture, system design, correctness | Code style, Node.js internals, config discipline | Test assertions, AGENTS.md quality, DX, debugger subsystem | Architecture, abstractions, naming, plugin correctness | Test isolation, memory safety, config hygiene, observability |
| Verbosity | Concise — short punchy comments | Moderate-verbose — explains rationale | Moderate — asks clarifying questions, uses emoji | Terse — direct statements, no softening | Moderate — pragmatic, willing to dismiss nits |
| Tone | Direct, matter-of-fact | Warm, encouraging, uses "Nit:" liberally | Warm, encouraging, emoji-heavy | Direct, no-emoji, assumes expertise | Practical, rhetorical questions, approves with caveats |
| Approval style | "LGTM!" or "LGTM. [one caveat]" | "LGTM, just left a few nits" / "RSLGTM" | "Great work 💯" / "Just a small nit, otherwise looks good 👍" | Empty APPROVED / "LGTM once CI and lint is fixed" | "I left some nit picks, up to you" / bare APPROVED |
| Top blocker | Architectural shortcuts that bypass designed interfaces | Missing config telemetry registration / broken async semantics | CI mechanisms that harm developer experience | Missing tests for bug fixes | Corrupted `supported-configurations.json` |
| Top nit | PR scope creep / unrelated changes | `_underscore` instead of `#private` fields | Redundant existence checks before value assertions | Static getters instead of static properties | require() calls not hoisted to top of file |
| Tests | Behavior-focused, no mocking internals | Correct semantics, combine assertions, safe async patterns | Minimal assertions, no redundant checks, standard `node:assert` | Every bug fix needs a test; no pointless helper wrappers | Self-contained `it` blocks, `beforeEach`/`afterEach` isolation |
| Performance | Hot path awareness, memory leaks, bounds | V8 object shape stability, avoid unnecessary allocations | Lazy vs. eager computation | No unnecessary abstractions | WeakMap for object-keyed maps, no unnecessary config options |
