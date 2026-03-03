# AsyncIterator Orchestrion Transform

**CRITICAL:** If you are working with async iterators or async generators (methods like `stream()`, `*generate()`, or anything returning `Promise<AsyncIterable>`), you **MUST** read and follow this entire document. The AsyncIterator pattern requires TWO plugins and has specific implementation requirements.

## When to Use AsyncIterator

Use `kind: 'AsyncIterator'` in your Orchestrion config when the target method:

- Returns `Promise<AsyncIterable<T>>`
- Returns `Promise<AsyncIterableIterator<T>>`
- Returns `Promise<IterableReadableStream<T>>`
- Is an async generator function: `async *methodName()`
- Returns any promise that resolves to an async iterable

**Examples:**
```javascript
// These ALL need kind: 'AsyncIterator'
async stream(input) { /* returns Promise<AsyncIterable> */ }
async *generate() { /* async generator */ }
async getStream() { /* returns Promise<ReadableStream> */ }
```

## Two-Channel Pattern

**When `kind: 'AsyncIterator'` is used, Orchestrion automatically creates TWO channels:**

1. **Base channel**: `tracing:orchestrion:{package}:{channelName}:*`
   - Fires when the method is called (before iteration starts)
   - Used to create the span

2. **Next channel**: `tracing:orchestrion:{package}:{channelName}_next:*`
   - Fires on EACH iteration (`next()` call)
   - Used to finish the span when `result.done === true`

## Critical Implementation Requirements

You **MUST** create TWO plugins to handle both channels. See the complete LangGraph example below for the full implementation pattern.

### 1. Channel Naming
- Base channel: Uses `channelName` from config exactly as-is
- Next channel: Automatically appends `_next` to `channelName`
- Plugin prefix MUST match the full channel name including `_next`

### 2. Plugin Class Relationship
- Next plugin typically extends the main plugin for consistency
- Both plugins MUST use the same `static id`
- Both plugins handle the same integration

### 3. Span Lifecycle
- **Main plugin `bindStart()`**: Creates span via `this.startSpan()`
- **Next plugin `bindStart()`**: Returns inherited store (NO new span)
- **Next plugin `asyncEnd()`**: Finishes span ONLY when `ctx.result.done === true`
- **Either plugin `error()`**: Finishes span immediately on error

### 4. Plugin Export and Registration
Both plugins MUST be:
- Exported from the plugin file: `module.exports = [StreamPlugin, NextStreamPlugin]`
- Registered in the plugin system (see LangGraph example below)

## Common Mistakes

### ❌ Only creating one plugin
```javascript
// WRONG - only handles base channel, span never finishes
class StreamPlugin extends TracingPlugin {
  static prefix = 'tracing:orchestrion:mypackage:Class_stream'
  // Missing the _next plugin!
}
```

### ❌ Creating new span in Next plugin
```javascript
// WRONG - creates multiple spans per iteration
class NextStreamPlugin extends StreamPlugin {
  bindStart (ctx) {
    this.startSpan('mypackage.stream', {}, ctx)  // ❌ DON'T DO THIS
    return ctx.currentStore
  }
}
```

### ❌ Finishing span on every iteration
```javascript
// WRONG - finishes span prematurely
class NextStreamPlugin extends StreamPlugin {
  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span.finish()  // ❌ Should check result.done first!
  }
}
```

### ❌ Wrong channel suffix
```javascript
// WRONG - suffix must be exactly _next
class NextStreamPlugin extends StreamPlugin {
  static prefix = 'tracing:orchestrion:mypackage:Class_stream_next_iteration'  // ❌
}
```

## Complete Example: LangGraph Stream

### Orchestrion Config
```javascript
// packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/langgraph.js
module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.2.0',
      filePath: 'dist/pregel/index.js'
    },
    functionQuery: {
      methodName: 'stream',
      className: 'Pregel',
      kind: 'AsyncIterator'  // ← Critical
    },
    channelName: 'Pregel_stream'
  }
]
```

### Plugin Implementation
```javascript
// packages/datadog-plugin-langchain-langgraph/src/tracing.js
const { TracingPlugin } = require('../../dd-trace/src/plugins/tracing')

class StreamPlugin extends TracingPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  bindStart (ctx) {
    const input = ctx.arguments?.[0]

    this.startSpan('langgraph.stream', {
      service: this.config.service,
      kind: 'internal',
      component: 'langgraph',
      meta: {
        'langgraph.input': JSON.stringify(input)
      }
    }, ctx)

    return ctx.currentStore
  }
}

class NextStreamPlugin extends StreamPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream_next'

  bindStart (ctx) {
    return ctx.currentStore  // Inherit span from StreamPlugin
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    if (ctx.result.done === true) {
      span.setTag('langgraph.chunks', ctx.result.value?.length || 0)
      span.finish()
    }
  }

  error (ctx) {
    const span = ctx.currentStore?.span
    if (span) {
      this.addError(ctx?.error, span)
      span.finish()
    }
  }
}

module.exports = [StreamPlugin, NextStreamPlugin]
```

## Testing AsyncIterator Integrations

When testing AsyncIterator instrumentation:

1. **Test span creation**: Verify span starts when method is called
2. **Test iteration**: Verify span stays open during iteration
3. **Test completion**: Verify span finishes when iterator is exhausted
4. **Test early termination**: Verify span finishes if iteration stops early
5. **Test error handling**: Verify span finishes and captures error

```javascript
it('should trace stream() method with AsyncIterator', async () => {
  const result = await myLib.stream(input)

  // Iterate through results
  const chunks = []
  for await (const chunk of result) {
    chunks.push(chunk)
  }

  // Verify span exists and finished
  await agent.assertSomeTraces(traces => {
    const span = traces[0][0]
    expect(span.name).to.equal('mylib.stream')
    expect(span.meta.component).to.equal('mylib')
    // Span should be complete after iteration finishes
  })
})
```

## Summary Checklist

When implementing AsyncIterator instrumentation:

- [ ] Orchestrion config uses `kind: 'AsyncIterator'`
- [ ] Created TWO plugin classes (Main + Next)
- [ ] Next plugin prefix has `_next` suffix
- [ ] Both plugins use same `static id`
- [ ] Main plugin creates span in `bindStart()`
- [ ] Next plugin returns inherited store in `bindStart()`
- [ ] Next plugin checks `result.done === true` before finishing span
- [ ] Both plugins handle errors and finish span
- [ ] Both plugins exported in module.exports array
- [ ] Tests verify span lifecycle (start, iteration, completion)
