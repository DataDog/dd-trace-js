# createIntegration Extensions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `createIntegration` to support per-intercept version ranges, a `prepare` lifecycle hook, and document `ctx.self`/`ctx.arguments` mutation.

**Architecture:** Add optional `versions` and `file` fields to `InterceptConfig` that override top-level values for orchestrion and hook generation. Add `prepare(ctx)` to `SpanConfig` that runs before span config evaluation in `bindStart`. Refactor hook generation to deduplicate across per-intercept overrides.

**Tech Stack:** Node.js, Mocha, `node:assert/strict`

---

## Design

## Problem

`createIntegration` currently handles simple "wrap a method, create a span" patterns (like sharedb), but most existing integrations need more flexibility:

- **Custom bindStart logic** — deriving span data from `ctx.self` or complex argument parsing (memcached's `getAddress`, langchain's handler dispatch)
- **Multiple version ranges** — different methods instrumented for different library versions (cassandra-driver: `_innerExecute` for 3-4.3, `_execute` for >=4.4)
- **Argument mutation** — modifying method arguments after span creation (tedious's DBM query injection)

## Design

### 1. Per-intercept `versions` and `file`

Each intercept can optionally override the top-level `versions` and `file`. When provided, these are used for that intercept's orchestrion entries and hook entries instead of the top-level values.

```js
createIntegration({
  id: 'cassandra-driver',
  module: 'cassandra-driver',
  versions: '>=3',
  type: 'database',
  system: 'cassandra',
  intercepts: [
    { className: 'Client', methodName: 'batch', kind: 'Callback', index: -1,
      span: { ... } },
    { className: 'Client', methodName: '_execute', kind: 'Async',
      versions: '>=4.4',
      span: { ... } },
    { className: 'Client', methodName: '_innerExecute', kind: 'Callback', index: -1,
      versions: '3 - 4.3',
      span: { ... } },
  ],
})
```

**Impact on generated outputs:**

- **orchestrion entries** — each entry uses `intercept.versions ?? config.versions` as the `versionRange`
- **hook entries** — deduplicated by `(moduleName, versions, file)` tuple across all intercepts, so version-specific intercepts produce separate hooks
- **plugin classes** — unchanged, one per channelName regardless of version

### 2. `span.prepare(ctx)` hook

A new optional function on the span config that runs before any other span config function. Its purpose is to enrich `ctx` with derived data that `resource`, `attributes`, `name`, etc. can then reference.

```js
span: {
  prepare (ctx) {
    ctx.query = Array.isArray(ctx.arguments[0]) ? combine(ctx.arguments[0]) : ctx.arguments[0]
    ctx.contactPoints = ctx.self.options?.contactPoints
  },
  name: 'cassandra.query',
  spanKind: 'client',
  resource (ctx) { return trim(ctx.query, 5000) },
  attributes (ctx) {
    return {
      'cassandra.query': ctx.query,
      'cassandra.keyspace': ctx.self.keyspace,
      'db.cassandra.contact.points': ctx.contactPoints?.join(','),
    }
  },
}
```

**Semantics:**

- Runs in `bindStart`, before `name`/`resource`/`attributes`/`service` are evaluated
- `this` is bound to the plugin instance (same as `onStart`/`onFinish`/`service`)
- Can stash arbitrary properties on `ctx` — these persist through the full TracingChannel lifecycle
- No return value expected

**Execution order in generated `bindStart`:**

1. `ctx.config = this.config`
2. `prepare.call(this, ctx)`
3. Evaluate `name(ctx)`, `resource(ctx)`, `attributes(ctx)`, `service(ctx)`
4. `this.startSpan(name, options, ctx)`
5. `onStart.call(this, ctx, span)`

### 3. `ctx.self` and `ctx.arguments` mutation

No new code needed — this documents the existing contract.

- **`ctx.self`** — orchestrion sets this to the `this` value of the instrumented method. Available in all span config functions.
- **`ctx.arguments`** — orchestrion sets this to the method's arguments array. Mutating entries in `prepare` or `onStart` causes the instrumented method to receive the modified values.
- **`ctx.result`** — available in `onFinish` (asyncEnd), contains the return value.

### 4. Hook deduplication

Hooks are now collected from each intercept's effective `(moduleName, versions, file)` and deduplicated:

```js
const hookMap = new Map()
for (const intercept of intercepts) {
  const v = intercept.versions ?? versions
  const files = intercept.file ? [intercept.file].flat() : filePaths
  for (const f of files) {
    const key = `${moduleName}:${v}:${f ?? ''}`
    if (!hookMap.has(key)) {
      const hook = { name: moduleName, versions: [v] }
      if (f) hook.file = f
      hookMap.set(key, hook)
    }
  }
}
```

---

## Implementation Tasks

### Task 1: Per-intercept `versions` — tests

**Files:**
- Modify: `packages/datadog-integrations/test/create-integration.spec.js`

**Step 1: Write failing tests for per-intercept versions**

Add to the `orchestrion` describe block:

```js
it('should use per-intercept versions when specified', () => {
  const { orchestrion } = createIntegration({
    id: 'test',
    module: 'test-pkg',
    versions: '>=1.0.0',
    type: 'server',
    intercepts: [
      { className: 'A', methodName: 'foo', kind: 'Async', versions: '>=2.0.0',
        span: { name: 'a', spanKind: 'server' } },
      { className: 'B', methodName: 'bar', kind: 'Async',
        span: { name: 'b', spanKind: 'server' } },
    ],
  })

  assert.strictEqual(orchestrion[0].module.versionRange, '>=2.0.0')
  assert.strictEqual(orchestrion[1].module.versionRange, '>=1.0.0')
})
```

Add to the `hooks` describe block:

```js
it('should produce separate hooks for per-intercept version overrides', () => {
  const { hooks } = createIntegration({
    id: 'test',
    module: 'test-pkg',
    versions: '>=3',
    type: 'server',
    intercepts: [
      { className: 'A', methodName: 'foo', kind: 'Async', versions: '>=4.4',
        span: { name: 'a', spanKind: 'server' } },
      { className: 'B', methodName: 'bar', kind: 'Callback', index: -1, versions: '3 - 4.3',
        span: { name: 'b', spanKind: 'server' } },
      { className: 'C', methodName: 'baz', kind: 'Async',
        span: { name: 'c', spanKind: 'server' } },
    ],
  })

  assert.strictEqual(hooks.length, 3)
  const versions = hooks.map(h => h.versions[0]).sort()
  assert.deepStrictEqual(versions, ['3 - 4.3', '>=3', '>=4.4'])
})
```

**Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js`
Expected: 2 failures — orchestrion entry uses top-level version, hooks dedup to 1

**Step 3: Commit**

```
test(integrations): add tests for per-intercept versions
```

---

### Task 2: Per-intercept `file` — tests

**Files:**
- Modify: `packages/datadog-integrations/test/create-integration.spec.js`

**Step 1: Write failing test for per-intercept file**

Add to the `orchestrion` describe block:

```js
it('should use per-intercept file when specified', () => {
  const { orchestrion } = createIntegration({
    id: 'test',
    module: 'test-pkg',
    versions: '>=1.0.0',
    file: 'lib/default.js',
    type: 'server',
    intercepts: [
      { className: 'A', methodName: 'foo', kind: 'Async', file: 'lib/other.js',
        span: { name: 'a', spanKind: 'server' } },
      { className: 'B', methodName: 'bar', kind: 'Async',
        span: { name: 'b', spanKind: 'server' } },
    ],
  })

  assert.strictEqual(orchestrion[0].module.filePath, 'lib/other.js')
  assert.strictEqual(orchestrion[1].module.filePath, 'lib/default.js')
})
```

**Step 2: Run tests to verify it fails**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js`
Expected: 1 failure — orchestrion entry uses top-level file

**Step 3: Commit**

```
test(integrations): add test for per-intercept file
```

---

### Task 3: `prepare` hook — tests

**Files:**
- Modify: `packages/datadog-integrations/test/create-integration.spec.js`

**Step 1: Write failing tests for prepare**

Add to the `plugin` describe block:

```js
it('should call prepare before resource and attributes', () => {
  const calls = []
  const { plugin } = createIntegration({
    id: 'test',
    module: 'test-pkg',
    versions: '>=1.0.0',
    type: 'tracing',
    intercepts: [{
      className: 'Foo', methodName: 'bar', kind: 'Async',
      span: {
        name: 'test.op',
        spanKind: 'client',
        prepare (ctx) { calls.push('prepare'); ctx.derived = 'value' },
        resource (ctx) { calls.push('resource'); return ctx.derived },
        attributes (ctx) { calls.push('attributes'); return { key: ctx.derived } },
      },
    }],
  })

  // Verify prepare is defined and the plugin was generated
  assert.strictEqual(typeof plugin.prototype.bindStart, 'function')
  assert.strictEqual(calls.length, 0, 'nothing should be called at definition time')
})

it('should bind prepare to the plugin instance', () => {
  let pluginInstance
  const { plugin } = createIntegration({
    id: 'test',
    module: 'test-pkg',
    versions: '>=1.0.0',
    type: 'tracing',
    intercepts: [{
      className: 'Foo', methodName: 'bar', kind: 'Async',
      span: {
        name: 'test.op',
        spanKind: 'client',
        prepare () { pluginInstance = this },
      },
    }],
  })

  assert.strictEqual(typeof plugin.prototype.bindStart, 'function')
})
```

**Step 2: Run tests to verify they pass (structural tests only)**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js`
Expected: PASS — these tests only verify plugin structure, not runtime behavior

**Step 3: Commit**

```
test(integrations): add tests for prepare hook
```

---

### Task 4: Implement per-intercept `versions` and `file`

**Files:**
- Modify: `packages/datadog-integrations/src/create-integration.js`

**Step 1: Update orchestrion entry generation**

In `createIntegration`, inside the `for (const intercept of intercepts)` loop, replace the inner `for (const filePath of filePaths)` block. Each intercept now computes its own effective versions and file paths:

Replace lines 160-188 (the inner `for` loop and orchestrion push):

```js
    const effectiveVersions = intercept.versions ?? versions
    const effectiveFilePaths = intercept.file
      ? [intercept.file].flat()
      : filePaths

    for (const filePath of effectiveFilePaths) {
      const entry = {
        module: {
          name: moduleName,
          versionRange: effectiveVersions,
        },
        functionQuery: {
          kind: intercept.kind,
        },
        channelName,
      }

      if (intercept.astQuery) {
        entry.astQuery = intercept.astQuery
      } else {
        entry.functionQuery.className = intercept.className
        entry.functionQuery.methodName = intercept.methodName
      }

      if (filePath) {
        entry.module.filePath = filePath
      }

      if (intercept.index !== undefined) {
        entry.functionQuery.index = intercept.index
      }

      orchestrion.push(entry)
    }
```

**Step 2: Refactor hook generation to use per-intercept values**

Replace the hook generation block (lines 132-139) with:

```js
  const hookMap = new Map()
  for (const intercept of intercepts) {
    const v = intercept.versions ?? versions
    const interceptFilePaths = intercept.file
      ? [intercept.file].flat()
      : filePaths
    for (const f of interceptFilePaths) {
      const key = `${moduleName}:${v}:${f ?? ''}`
      if (!hookMap.has(key)) {
        const hook = { name: moduleName, versions: [v] }
        if (f) hook.file = f
        hookMap.set(key, hook)
      }
    }
  }
  const hooks = [...hookMap.values()]
```

**Step 3: Run tests**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js`
Expected: ALL PASS

**Step 4: Commit**

```
feat(integrations): support per-intercept versions and file overrides
```

---

### Task 5: Implement `prepare` hook

**Files:**
- Modify: `packages/datadog-integrations/src/create-integration.js`

**Step 1: Add prepare call in createPluginClass bindStart**

In the generated `bindStart` method inside `createPluginClass`, add the `prepare` call after `ctx.config = this.config` and before evaluating `name`:

```js
    bindStart (ctx) {
      ctx.config = this.config

      if (spanConfig.prepare) {
        spanConfig.prepare.call(this, ctx)
      }

      const name = typeof spanConfig.name === 'function'
```

**Step 2: Update JSDoc for SpanConfig**

Add `prepare` to the `SpanConfig` typedef:

```js
 * @property {function(this: TracingPlugin, Object): void} [prepare] - Called before span creation
 *   in bindStart. Receives ctx with `this` bound to the plugin instance. Use to enrich ctx with
 *   derived data (e.g. from ctx.self, ctx.arguments) that resource/attributes/name can reference.
```

**Step 3: Update JSDoc for InterceptConfig**

Add `versions` and `file` to the `InterceptConfig` typedef:

```js
 * @property {string} [versions] - Semver range override. When set, this intercept's orchestrion
 *   entries and hook entries use this version range instead of the top-level config.versions.
 * @property {string|string[]} [file] - File path override. When set, this intercept's orchestrion
 *   entries and hook entries use this file path instead of the top-level config.file.
```

**Step 4: Run tests**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js`
Expected: ALL PASS

**Step 5: Commit**

```
feat(integrations): add prepare lifecycle hook to span config
```

---

### Task 6: Update JSDoc for ctx.self/ctx.arguments/ctx.result

**Files:**
- Modify: `packages/datadog-integrations/src/create-integration.js`

**Step 1: Add ctx documentation to SpanConfig typedef**

Add a note block after the SpanConfig typedef describing the ctx object shape:

```js
/**
 * The `ctx` object passed to all SpanConfig functions is provided by orchestrion's TracingChannel
 * and includes:
 * - `ctx.self` — the `this` value of the instrumented method
 * - `ctx.arguments` — the method's arguments (mutable: changes are seen by the original method)
 * - `ctx.result` — the return value (available in onFinish/asyncEnd only)
 * - `ctx.config` — the plugin's config object (set by the generated bindStart)
 * - `ctx.currentStore` — the current async store (available after startSpan)
 * - `ctx.parentStore` — the parent async store
 * Any additional properties stashed on ctx in `prepare` or `onStart` persist through the
 * full TracingChannel lifecycle (asyncStart, asyncEnd, error).
 */
```

**Step 2: Commit**

```
docs(integrations): document ctx shape for span config functions
```

---

### Task 7: Run full test suite and verify existing tests still pass

**Step 1: Run all integration tests**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js`
Expected: ALL PASS (existing + new tests)

**Step 2: Run registry tests**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/registry.spec.js`
Expected: ALL PASS

**Step 3: Run sharedb tests**

Run: `./node_modules/.bin/mocha packages/datadog-integrations/test/integrations/sharedb.spec.js`
Expected: ALL PASS
