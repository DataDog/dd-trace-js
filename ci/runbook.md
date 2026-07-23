# Datadog Test Optimization Validation Runbook

Use this runbook only when asked to validate Test Optimization in the current repository. The validator checks whether
an existing test can report when Datadog is initialized correctly, audits the identified CI configuration, and exercises
eligible advanced features with temporary tests. It diagnoses and recommends changes; it never applies fixes.

## Human-Facing Provenance and Command Effects

This file is shipped as `ci/runbook.md` in the public `dd-trace` npm package. Its validator entrypoint is
`ci/validate-test-optimization.js`. The public Test Optimization setup documentation is
https://docs.datadoghq.com/tests/setup/javascript/.

Before executing the validator, confirm that the resolved package name and version match the repository's expected
`dd-trace` installation and use the package manager's lockfile/integrity metadata to establish its origin. These
identifiers help recognize the intended workflow; they do not prove package provenance. A symlink to a live source
checkout is useful for validator development but is not equivalent to a customer's normal lockfile-backed npm
installation.

| Command mode | Executes project code? | Filesystem effect |
| --- | --- | --- |
| `--init-manifest` | No | Exclusively creates `./dd-test-optimization-validation-manifest.json`; refuses to overwrite it |
| `--validate-manifest` | No | Validates the selected manifest without creating validation outputs |
| `--print-plan` | No | Writes the plan, approval record, and checksum list under the selected results directory |
| `--run-approved-plan` | Yes | Runs only the checksum-bound plan and writes its declared temporary files and results |

## Agent Contract

1. Work only in the current repository and resolve its installed `dd-trace`; do not search sibling repositories, home
  directories, package-manager stores, or unrelated `node_modules` trees.
2. Pre-live discovery does not execute project code or use the network, but it is not filesystem-read-only:
  `--init-manifest` creates only the default manifest and `--print-plan` creates only the declared plan artifacts. Do not
  install dependencies, start services, or run tests before the generated plan discloses an action and the customer
  approves it. If the platform presents a native permission control scoped to the exact pre-live command and its
  declared paths, request it at most once and retry that unchanged command at most once. A raw `EACCES` or `EPERM`
  error does not prove that such a permission is available.
3. Record `git status --short` as the cleanup baseline, then run `--init-manifest` immediately. The bounded scaffold owns
  normal CI, framework, configuration, and test discovery.
4. Treat the scaffold as a proposal. Inspect only the paths named by an explicit review request; do not repeat broad
  repository discovery when it reports a complete proposal.
5. Run `--print-plan` after the manifest validates. It writes and prints one complete customer approval plan. Present
  that complete plan in the next user-facing message; do not replace it with a summary or an invisible file reference.
6. Obtain one explicit approval for the plan by asking: `Approve executing exactly the plan above?` Use the platform's
  command-approval dialog instead of a chat question when one is available without changing the command or permissions.
  Do not request duplicate approval for the same plan.
7. After approval, run only the checksum-bound command shown in the plan. The validator owns preflight, temporary tests,
  offline fixtures, checks, artifacts, and cleanup.
8. If the platform hard-denies a command and says chat approval cannot authorize it, do not retry the unchanged command,
  request a broad shell allowlist, or suggest bypass mode. Follow the Platform Trust-Gate Fallback below.
9. With no `--scenario`, report CI configuration, Basic Reporting, EFD, ATR, Test Management, blockers, cleanup, and
  the local report path. Never apply a recommendation during validation.

## Safety and Privacy

- Use this workflow only in a trusted repository with trusted installed dependencies. Validation runs the disclosed
  project test commands with the developer's OS privileges, just as running those commands directly would. Use an
  external sandbox for an unfamiliar or untrusted repository; providing that sandbox is outside this workflow.
- Do not edit agent instructions, CI, project manifests, lockfiles, source, configuration, or existing tests. Allowed
  writes are the validator-created validation manifest, declared validation outputs, and plan-listed temporary files.
- Approval detects drift only in inputs it explicitly covers: validator files, the manifest, approved command shapes and
  selected launch inputs, generated files, and execution options. It does not comprehensively fingerprint existing
  tests, runner configuration, shell or interpreter behavior, transitive dependencies, or the current values of
  explicitly inherited non-secret environment variables.
- Do not inspect environment files, credential stores, keychains, agents, or sockets to assess safety, and do not ask the
  user to attest that no credentials exist.
- Never upload validation outputs automatically. They may expose paths, commands, package names, CI names, and sanitized
  environment structure. Redaction is best-effort; the user must review and intentionally choose what to share with
  Datadog Support or another trusted recipient.

The validator-controlled offline transport uses private filesystem fixtures and bounded local artifacts. It prevents the
tracer's normal Datadog communication, opens no listener, and requires no Datadog Agent or API key. Project commands may
still use the network and local resources or need normal browser, service, and localhost permissions.

## 1. Create the Manifest Proposal

Resolve `dd-trace` from this repository, for example with
`require.resolve('dd-trace/package.json', { paths: [process.cwd()] })`, then run:

```bash
node ./node_modules/dd-trace/ci/validate-test-optimization.js --init-manifest
```

The scaffold performs bounded, hidden-file-aware discovery and proposes up to three small whole-file candidates for each
distinct supported runner shape. It prefers repository-representative, service-free unit tests and records duplicate or
ineligible commands as omissions. Reporters, benchmarks, typecheck-only commands, watch commands, smoke scripts, and
custom unsupported runners are not runnable Test Optimization frameworks.

Live adapters exist for Cucumber, Cypress, Jest, Mocha, Playwright, and Vitest. Other runners are diagnostic-only.
Say `validator adapter unavailable`, not `no runnable command`, when validator support is the missing piece.

### Review Only When Requested

When the scaffold explicitly requests review, inspect `ciDiscovery.reviewTargets` in order and select the first test job
for which both project identity and a real test-command anchor can be proven. Project identity may come from the selected
working directory, project/package name, or a project-relative configuration or test path. Separately, inert parsing must
prove that the job invokes the exact selected package script or the matching framework runner, either directly or at the
end of the resolved wrapper chain. Static `cross-env` assignments, `c8`/`nyc` options, and non-evaluating `npx` options
may transparently prefix that terminal runner. Arbitrary child commands and `npx -c`/`--call` do not prove linkage.
Do not attach a browser, fixture, example, or sibling-package job to a different local representative merely because it
uses the same framework. If no job can be linked to the selected project, keep CI evidence unresolved. Inspect only named
workflow, package, configuration, and test paths needed to resolve a named field. Do not run broad `find`, `rg --files`,
workflow dumps, dependency-tree searches, schema reads, or full-manifest dumps.

Record CI evidence in these manifest fields for each selected framework with relevant CI evidence:

- `ciWiring.configFile`: absolute path to the selected CI configuration file.
- `ciWiring.job`: exact job identifier; `ciWiring.step`: exact step name or `null`.
- `ciWiring.command`: exact inert command text from the selected test step.
- `ciWiring.workingDirectory`: absolute command working directory or `null`; `ciWiring.shell`: configured shell or `null`.
- `ciWiring.wrapperChain`: ordered exact wrapper records. Each record contains `source`, `command`, and an optional
  absolute `workingDirectory`. Put explanations in evidence fields, never inside `command`.
- `ciWiring.terminalTestCommand`: the exact final runner command extracted from the last wrapper, with `command`,
  `framework`, absolute `projectRoot`, and runner `mode`. The terminal command must appear literally in the final wrapper
  command. For example, record `pnpm vitest run --project main` separately from
  `mise x node@22 -- pnpm vitest run --project main`.
- A matching working directory, framework name, configuration filename, or test filename is not sufficient by itself.
  The evidence must prove both the selected project scope and a structural invocation of the selected package script or
  framework runner, using the same runner mode (for example, Node Vitest versus browser Vitest). Otherwise leave
  `ciWiring.unresolved` non-empty and explain that no matching CI test job was proven.
- `ciWiring.initialization`: `status` plus concrete evidence from the selected job and wrapper chain.
- `ciWiring.transport`: `mode` (`agentless`, `agent`, `none`, or `unknown`) plus concrete evidence for every conclusive
  mode. Keep it `unknown` until the selected job's agentless settings, Agent/sidecar availability, or confirmed absence
  has been reviewed. Missing Agent environment variables alone never prove `none`.
- `ciWiring.unresolved`: remaining includes, inherited configuration, wrappers, services, matrix values, or setup unknowns.

Keep `initialization.status` as `unknown` and keep `unresolved` non-empty until `configFile`, `job`, `command`, includes,
inherited configuration, and wrappers are resolved. `--validate-manifest` rejects a conclusive status or an empty
`unresolved` list when `configFile`, `job`, or `command` is missing. Keep secret names only; use
`dd-validation-placeholder` for executable secret values.

### Candidate Rules

- Prefer one whole existing test file without a test-name filter. Keep at most two disclosed fallbacks for the same
  runner shape. Respect literal test roots in the selected runner command and statically readable package configuration;
  do not select a file outside that scope.
- Ask the framework to run only the selected file. When a package script already contains positional globs or test
  directories that would be combined with the selected file, use the installed framework runner directly and retain
  statically proven configuration, preload, environment, and runner-mode arguments. Preserve a custom project wrapper
  when it accepts an exact framework selector and passes the same command-suitability checks used by plan generation.
- A project command may still run additional tests when its wrapper semantics cannot be proven. Do not reject it because
  of the observed test count. The clean preflight succeeds when the command exits `0` within its approved timeout and
  does not explicitly report zero tests. Record the observed count as diagnostic evidence.
- Add an `origin: validator-direct` isolation candidate for each fallback only when its exact existing test file,
  configuration, runner mode, semantic runner options, and working directory are proven. It runs only after
  that project command passes cleanly and its initialized execution does not establish the complete event hierarchy,
  including when controlled initialization or offline settings do not load.
- If the selected command needs an existing non-secret project variable such as `NODE_ENV` or a test-mode selector,
  record only its name in `command.requiredEnvVars`. Do not inspect or copy its value into the manifest. Never inherit
  `DD_*`, secret-like variables, or variables that can alter executable/configuration loading such as `NODE_OPTIONS`,
  `NODE_PATH`, or `BASH_ENV`. The approval plan names inherited variables; a missing value is reported as project setup.
- Reject mixed-runner files before approval: a Vitest candidate must not import `node:test` or `@jest/globals`.
- Respect pinned runtimes and package managers. Invoke checked-in Yarn as `node .yarn/releases/yarn-*.cjs`. Never
  synthesize Corepack, install a package manager, or activate a downloaded toolchain.
- System- or Volta-managed `npm`, `pnpm`, `yarn`, and Node.js runtime executables may resolve outside the repository.
  Fingerprint their canonical files in the approval and revalidate them before spawn; do not require repository
  containment for those toolchain launchers. Continue to require containment for framework runner entrypoints,
  project-controlled Node.js programs, preloads, imports, loaders, and configuration-bearing project files.
- Do not add a second `--` when forwarding focused arguments through pnpm or Yarn scripts. npm scripts may use their one
  documented separator. Preserve project-owned Vitest `--typecheck` behavior; the clean preflight and timeout determine
  whether that command is usable.
- Prefer tests that do not start local servers. If every suitable test needs a browser, service, database, build output,
  or localhost listener, disclose that prerequisite and report a project-setup blocker if it is unavailable.

The validator never installs dependencies or package managers, activates Corepack, downloads browsers, starts Docker, or
infers and executes project setup. A runnable manifest cannot contain setup commands. When setup is required, name the
exact prerequisite and evidence, preserve the CI audit result, and tell the user to complete setup separately before
requesting a fresh plan.

### Framework Notes

- Cucumber Basic Reporting uses one existing `.feature` and statically retained repository configuration arguments. Temporary
  advanced checks use isolated feature and step-definition files. Basic Reporting requires Cucumber 7+; ATR requires 8+.
  A checkout of the Cucumber framework itself is not equivalent to a customer project loading `@cucumber/cucumber` from
  `node_modules`; reproduce there before classifying missing events as a dd-trace adapter bug.
- Cypress, Playwright, and explicit Vitest browser-mode Basic Reporting use real repository tests and may require their
  normal browser provider, application, browser, web-server, or localhost permissions. The validator never installs a
  browser provider, downloads a browser, or replaces a blocked real test with a synthetic compatibility claim. A
  Playwright candidate may establish runner ownership through one statically resolved, repository-contained local
  fixture that directly imports `@playwright/test` and exports `test`; fixture chains are not followed. Playwright output
  is redirected to a plan-listed validator-owned directory and removed after each command.
- If a sandbox blocks a disclosed browser or project localhost operation, state what the project test needed and that no
  conclusion was reached. Tell the user to retry the same plan in an environment where the project prerequisite is
  available. Do not request broader permissions automatically.

## 2. CI Configuration Audit

Basic Reporting and CI configuration answer different questions and run independently:

- **Basic Reporting** runs the selected project wrapper or repository-installed runner with validator-supplied Datadog
  initialization and writes size-limited offline events. It does not prove delivery to the Datadog backend.
- **CI configuration audit** inspects the identified job and wrapper chain. It checks for
  `NODE_OPTIONS=-r dd-trace/ci/init`, whether statically visible wrappers preserve it, and whether agentless reporting is
  configured or a Datadog Agent is expected to be available.

The audit is deliberately static. Any negative conclusion, including missing initialization, an explicit `NODE_OPTIONS=`
reset, a visible environment allowlist omission, or missing reporting transport/API-key configuration, is confirmed only
after identifying the actual test job, exact command, and wrapper chain with no unresolved includes or inherited
configuration. Transport `none` also requires concrete evidence from that completed review; the absence of Agent
environment variables is insufficient. A broad literal scan remains inconclusive. Configuration that appears correct is
reported as propagation unverified unless runtime evidence exists. Do not invent or run a narrowed local command as
proof of the real CI job.

The CI audit runs even when the framework is not locally runnable, project setup is unavailable, a browser or service is
missing, clean preflight fails, or the execution environment blocks project code. Configuration that looks correct is
still runtime-unverified. Recommend rerunning the exact identified CI step with `DD_TRACE_DEBUG=1`; do not apply it.

Recommend agentless reporting by default with `DD_CIVISIBILITY_AGENTLESS_ENABLED=true` and `DD_API_KEY` from the CI
secret store. When a reachable Datadog Agent is intentionally used, those two variables are not required. Recommend a
contextual `DD_SERVICE` and `DD_TEST_SESSION_NAME`; do not present validator fixture variables as customer settings.

## 3. Validate the Manifest

Preserve scaffold command boilerplate and edit only fields the scaffold explicitly asks the agent to resolve. Do not
reconstruct the manifest from a schema. Keep all manifest path fields absolute and inside the repository; command
arguments may remain relative to their working directory.

Use `localTestCandidates` for clean preflight and Basic Reporting. The validator tries candidates in disclosed order and
selects the first that exits `0` within its approved timeout and does not explicitly report zero tests. A count that is
unknown or larger than expected is diagnostic evidence, not a rejection. Every entry in `isolationTestCandidates` must
name its matching project-candidate index, remain direct, Datadog-clean, and repository-contained, and carry explicit
equivalence metadata. A scaffold may also retain `isolationTestCandidate` as the candidate-zero compatibility alias.

The scaffold owns temporary `basic-pass`, `atr-fail-once`, and `test-management-target` recipes. Each framework uses its
own generated files, state, identity, and cleanup paths. The validator rejects modified source, mismatched paths, commands
that do not select their declared file, shared cross-framework paths, and incomplete cleanup.

Validate without running project code:
```bash
node ./node_modules/dd-trace/ci/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json --validate-manifest
```

## 4. Print and Approve the Plan

```bash
node ./node_modules/dd-trace/ci/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results --print-plan
```

This writes and prints `./dd-test-optimization-validation-results/execution-plan.md`. It contains every possible project
command and working directory, execution count, temporary test source, cleanup path, command-created output, local
artifact path, integrity check, and the final checksum-bound validator command. It also writes `approval.json` and a
standard checksum list. The approval SHA-256 covers the explicitly reviewed validator files, manifest, command shapes,
selected launch inputs, generated files, and execution options; the plan includes a standard command that can reproduce
it. It detects changes to those covered inputs, not to every file project code may load, and does not establish package
provenance.

Successful plan generation ends discovery. Make the complete delimited plan visible, then obtain the single approval in
the Agent Contract.

### Platform Trust-Gate Fallback

Distinguish a native, narrowly scoped permission control from a raw operating-system permission error and from a hard
classifier denial that explicitly cannot be changed by chat approval:

- If the platform offers a native permission control scoped to the exact pre-live command and its declared paths,
  request it at most once and retry the unchanged command at most once. Do not treat a raw `EACCES` or `EPERM` as
  evidence that this platform permission exists.
- If a pre-live command receives a raw permission denial without that narrowly scoped control, or is hard-denied, stop
  after that one denial. Show the exact command, its working directory, and the bounded write described in the
  command-effects table. The user may run it in their terminal and ask the agent to continue from the artifact it
  creates.
- If the approved live command is hard-denied, stop after that one denial. Show the exact checksum-bound command and
  working directory from the approved plan. The user may run it in their terminal and then ask the agent to interpret
  `./dd-test-optimization-validation-results/report.md`.
- Never retry an unchanged hard-denied command, claim another chat confirmation can override the classifier, enable
  bypass mode, change filesystem permissions, use `sudo`, or recommend a broad shell permission rule.

## 5. Interpret and Report

The validator runs the approved selected command cleanly first. If it exceeds the approved timeout, Basic Reporting is
incomplete because the command could not be tested reliably. If Datadog changes the outcome, it reruns the same clean
command once: a changing clean result is an unstable baseline, while two agreeing clean runs plus a Datadog-only failure
indicate a possible `dd-trace` compatibility problem. Never call a failure pre-existing unless the clean run reproduces
it. If the project command passes cleanly but initialized events are incomplete, the disclosed isolation command may
separate wrapper propagation from possible tracer or adapter behavior, including initialization/settings failures; it
does not erase the project-command finding.

Advanced checks run when either the project command or equivalent isolation establishes complete session, module, suite,
and test events. Each generated scenario must first pass its clean contract: exactly one selected test; Basic/EFD and
Test Management exit `0`; ATR's fail-once baseline exits `1` before retries are enabled. Without this foundation,
advanced checks are `not reached`/incomplete, never feature failures. The CI audit never gates them.

Scenario selection is exact: `ci-wiring` runs only the audit; `basic-reporting` runs only Basic Reporting; selecting
`efd`, `atr`, or `test-management` runs Basic Reporting plus that advanced check. Framework targeting applies once and
reports only checks selected for that scope.

Lead the final response with the strongest actionable diagnosis and a compact table, then include coverage, blockers,
cleanup, the validator's `How to fix`, and links to:

- `./dd-test-optimization-validation-manifest.json`
- `./dd-test-optimization-validation-results/report.md`

Read only a linked failure artifact when the console says evidence is incomplete or an implementation error needs
diagnosis. Otherwise summarize the console result without loading the full report back into context.

Exit codes are: `0` completed without a confirmed problem, `1` completed with a confirmed actionable problem, `2`
incomplete or blocked, and `3` validator implementation/orchestration error. A nonzero exit does not by itself mean the
validator crashed.

State whether coverage is complete or partial. Preserve useful Basic Reporting, advanced-feature, and CI conclusions when
another dimension is incomplete. If no Basic Reporting check ran, local compatibility remains incomplete even when the
static CI audit found a configuration problem. An unexplained browser or runner abort is a local-runtime blocker, not
project setup or a library failure. Never turn missing runtime evidence into a library failure.

Any copy-ready CI step must preserve the original workflow command exactly. If it is unknown, provide only an
environment block for the identified step; never invent a test command.

Finally compare changed paths with the cleanup baseline. Remove only validation-created files, preserve prior work, and
leave no project changes outside the declared outputs.
