# Diagnostic Channels Deep Dive

dd-trace uses Node.js diagnostic channels (via dc-polyfill) for communication between instrumentations and plugins.

## runStores vs publish

### runStores(ctx, callback)
Runs callback within AsyncLocalStorage context:
```javascript
return startCh.runStores(ctx, () => {
  const result = original.apply(this, args)
  return result
})
```

**Use for**:
- Start events (ALWAYS)
- Any event where child code needs span access

### publish(ctx)
Simple event emission, no context binding:
```javascript
errorCh.publish({ error, operation })
```

**Use for**:
- Error notifications
- Finish events (no callback needs context)

### Summary Table

| Event | Method | Why |
|-------|--------|-----|
| **Start** | `runStores()` | ALWAYS — establishes async context |
| **Finish** | `publish()` | Just notification, context already established |
| **Error** | `publish()` | Just notification |
| **AsyncStart** | `runStores()` | For continued async context |
| **AsyncEnd** | `publish()` | Just notification |

## Channel Event Lifecycle

```
┌─────────────────────────────────────┐
│ startCh.runStores(ctx, () => {      │ ← start event
│   try {                             │
│     const result = original()       │
│     if (result.then) {              │
│       return result                 │
│         .then(val => {              │
│           ctx.result = val          │
│           finishCh.publish(ctx)     │ ← asyncEnd event
│         })                          │
│         .catch(err => {             │
│           ctx.error = err           │
│           errorCh.publish(ctx)      │ ← error event
│         })                          │
│     }                               │
│     finishCh.publish(ctx)           │ ← end event (sync)
│   } catch (err) {                   │
│     errorCh.publish(ctx)            │ ← error event
│   }                                 │
│ })                                  │
└─────────────────────────────────────┘
```

## Callback Wrapping for Context

For callback-based APIs, wrap the callback to maintain context:
```javascript
startCh.runStores(ctx, () => {
  return originalWithCallback(arg, (err, result) => {
    if (err) {
      ctx.error = err
      errorCh.publish(ctx)
    } else {
      ctx.result = result
      finishCh.publish(ctx)
    }
    return originalCallback.apply(this, arguments)
  })
})
```

## Three Channel Types

### 1. Plain Diagnostic Channels (dc.channel)
Exact name, no transformation:
```javascript
const ch = channel('apm:express:request:handle')
ch.publish({ req, res })
```

### 2. Tracing Channels (dc.tracingChannel)
Auto-creates suffixed event channels:
```javascript
const ch = tracingChannel('apm:mylib:query')
// Creates:
//   tracing:apm:mylib:query:start
//   tracing:apm:mylib:query:end
//   tracing:apm:mylib:query:asyncStart
//   tracing:apm:mylib:query:asyncEnd
//   tracing:apm:mylib:query:error
```
**Prefer tracingChannel over plain channels** — consistent with orchestrion's internal behavior.

### 3. Orchestrion Channels
Auto-generated from JSON config:
```
tracing:orchestrion:{module.name}:{channelName}:{event}
```
See orchestrion reference in the repo's `apm-integrations` skill for full details.

## Channel Naming Conventions

| Pattern | Example | Use Case |
|---------|---------|----------|
| `apm:{lib}:{op}:start` | `apm:pg:query:start` | Operation start |
| `apm:{lib}:{op}:finish` | `apm:pg:query:finish` | Operation end |
| `apm:{lib}:{op}:error` | `apm:pg:query:error` | Error occurred |
| `tracing:apm:{lib}:{op}` | `tracing:apm:undici:fetch` | tracingChannel (auto-suffixed) |
| `tracing:orchestrion:{module}:{name}` | `tracing:orchestrion:@langchain/core:invoke` | Orchestrion (auto-suffixed) |

## hasSubscribers Optimization

Check before creating expensive context:
```javascript
if (!startCh.hasSubscribers) {
  return original.apply(this, arguments)
}

// Only runs if plugin is listening
const ctx = {
  expensiveData: computeSomething()
}
startCh.runStores(ctx, ...)
```
