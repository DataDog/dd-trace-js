# Fix undici AsyncLocalStorage context leak (#9387)

## Offline Issue Source

- GitHub issue: `DataDog/dd-trace-js#9387`
- Title: `[BUG]: undici plugin leaves finished span active in ALS after request (shared trace_id leak)`
- Base revision: `origin/master` at `82b10d54d25238dc92f841e1400c73386ade80ef`

This file contains the issue context required for this task. Do not depend on GitHub access.

## Reported Environment

- `dd-trace` 5.108.0 (reporter also reproduced with 5.114.0)
- Node.js 24.10.0
- `undici` 6

## Problem

After an instrumented `undici` request completes, its finished `undici.request` span can remain active in
AsyncLocalStorage. A later unrelated `tracer.trace(...)` then becomes a child of that finished span. In a
long-lived worker, a startup health check can therefore cause all later independent jobs to share one trace ID.

Current suspected lifecycle shape in `packages/datadog-plugin-undici/src/index.js`:

```js
const store = storage('legacy').getStore()
// create span
storage('legacy').enterWith({ ...store, span })

// completion, error, or CONNECT body-sent callback
span.finish()
if (store) storage('legacy').enterWith(store)
```

For a root request there is no previous store, so the conditional restoration does not clear the request span.
Do not assume this diagnosis is sufficient: inspect the actual context-storage API and existing lifecycle paths
before choosing a minimal fix.

## Expected Behavior

After a root request completes, `tracer.scope().active()` is `null` (or the genuine parent is restored).
Independent `tracer.trace('independent-work')` calls then each create their own root trace ID.

## Actual Behavior

After completion, `tracer.scope().active()` is still `undici.request`. Five later independent traces share one
trace ID. The failure is silent: there is no exception, only incorrect trace parenting and context retention.

## Reporter Reproduction

Create `repro.js` and run it against the changed local tracer. Adapt package loading only as needed for this
repository checkout; preserve the assertions and record the before/after output.

```js
'use strict'

process.env.DD_TRACE_STARTUP_LOGS = 'false'
process.env.DD_TRACE_TELEMETRY_ENABLED = 'false'
process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

const tracer = require('dd-trace').init({
  service: 'undici-als-leak-repro',
  env: 'local',
  sampleRate: 1,
})
const http = require('http')
const { Agent, request } = require('undici')

function activeName () {
  const span = tracer.scope().active()
  return span ? span._name : null
}

;(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const agent = new Agent()
  const origin = `http://127.0.0.1:${port}`

  await Promise.all([
    request(`${origin}/a`, { dispatcher: agent }).then(response => response.body.text()),
    request(`${origin}/b`, { dispatcher: agent }).then(response => response.body.text()),
  ])

  console.log('active after undici:', activeName())
  const ids = []
  for (let i = 0; i < 5; i++) {
    tracer.trace('independent-work', () => ids.push(tracer.scope().active().context().toTraceId()))
  }
  console.log({ uniqueTraceIds: new Set(ids).size, ids })

  server.close()
  await agent.close()
  process.exit(new Set(ids).size === 1 ? 2 : 0)
})().catch(error => {
  console.error(error)
  process.exit(1)
})
```

The reporter observed `active after undici: undici.request`, `uniqueTraceIds: 1`, and exit code 2. The fixed
case must show no finished undici request as active and five unique IDs.

## Constraints and Scope

- Product scope is limited to `packages/datadog-plugin-undici/src/index.js`, its focused tests, and essential
  test helpers. Do not refactor global context APIs or unrelated undici behavior.
- Preserve correct restoration when a real parent span/store exists.
- Inspect all lifecycle completions affected by native requests: normal trailers/completion, error, and CONNECT
  body-sent paths. Cover every modified path with focused tests or explain why a path is unreachable.
- Before editing, use focused subagents to inspect the plugin lifecycle/tests and the original decision history.
  In particular inspect commit `4afcb7eed` (`fix(undici) unfinished CONNECT span #8558`) and its surrounding
  code to avoid regressing its intended behavior.
- Use focused subagents for implementation, failure diagnosis, and adversarial review; the main agent should
  coordinate and validate their evidence rather than perform all substantive work itself.
- Keep evidence compact under this bundle's `evidence/` directory. Do not commit evidence or the control bundle
  in the product implementation commit.

## Acceptance Gates

1. Capture the baseline reproduction before production edits whenever feasible. It should demonstrate the stale
   active span and shared trace ID behavior.
2. After the fix, run the reproduction and retain inspectable local span/trace evidence proving the root-request
   span is no longer active and independent work creates distinct trace IDs.
3. Add focused regression coverage for root requests and parent restoration. Include lifecycle variants changed by
   the implementation, including errors and CONNECT where supported.
4. Run the bundle's final build, focused tests, lint, final review, and observability gates on one unchanged source
   revision. A green unit test alone is insufficient.
5. Do not open a PR until every gate has evidence. If local trace capture cannot run, stop as BLOCKED with the
   exact missing capability rather than claiming success.
