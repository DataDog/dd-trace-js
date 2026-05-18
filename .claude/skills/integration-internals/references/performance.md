# Performance & Code Quality

dd-trace runs in application hot paths. Every operation counts.

## Hot-Path Rules

### Avoid Allocations
```javascript
// BAD — new object every call
function getConfig() {
  return { timeout: 5000, retries: 3 }
}

// GOOD — reuse static object
const CONFIG = { timeout: 5000, retries: 3 }
function getConfig() {
  return CONFIG
}
```

### Avoid Closures
```javascript
// BAD — closure created every call
items.forEach(item => process(item))

// GOOD — no closure
for (const item of items) {
  process(item)
}
```

### Avoid Intermediate Arrays
```javascript
// BAD — creates two intermediate arrays
const result = items.filter(x => x.valid).map(x => x.value)

// GOOD — single pass
const result = []
for (const item of items) {
  if (item.valid) result.push(item.value)
}
```

### Loop Selection

| Pattern | Use When |
|---------|----------|
| `for-of` | Simple iteration, readability |
| `for` with index | Need index, hot path performance |
| `while` | Custom iteration logic |
| `.forEach()` | Test files only |
| `.map()/.filter()` | Test files only, one-time init |

## hasSubscribers Optimization

Always check before creating context objects:

```javascript
// GOOD — skip work when not needed
if (!startCh.hasSubscribers) {
  return original.apply(this, arguments)
}

const ctx = {
  query: buildQueryString(),  // Only computed when needed
  metadata: extractMetadata()
}
startCh.runStores(ctx, ...)
```

## GC Pressure

### Avoid Spread in Hot Paths
```javascript
// AVOID — creates new object
const newCtx = { ...ctx, result }

// PREFER — mutate existing
ctx.result = result
```

### Cache Repeated Access
```javascript
// BAD — multiple property lookups
if (ctx.self.config.database) {
  span.setTag('db.name', ctx.self.config.database)
  span.setTag('db.instance', ctx.self.config.database)
}

// GOOD — cache the value
const database = ctx.self?.config?.database
if (database) {
  span.setTag('db.name', database)
  span.setTag('db.instance', database)
}
```

## Logging

Use printf-style formatting (deferred evaluation):

```javascript
// BAD — string built even if log level disabled
log.debug(`Processing ${name} with ${JSON.stringify(data)}`)

// GOOD — printf-style
log.debug('Processing %s with %j', name, data)

// GOOD — callback for expensive ops
log.debug(() => `Complex: ${expensiveOperation()}`)
```

## Error Handling

### Never Crash Customer Apps
```javascript
// In instrumentations — fallback to original
try {
  // Instrumentation logic
} catch (error) {
  log.error('Instrumentation error: %s', error.message)
  return original.apply(this, arguments)
}
```

### Never Use try/catch in Hot Paths
```javascript
// AVOID — try/catch has performance cost
function hotPath(data) {
  try { return data.value } catch (e) { return null }
}

// PREFER — validate early
function hotPath(data) {
  if (!data?.value) return null
  return data.value
}
```

## Code Quality Checklist

- [ ] No `.forEach()`, `.map()`, `.filter()` in hot paths
- [ ] No unnecessary object/array allocations
- [ ] `hasSubscribers` check before expensive operations
- [ ] Defensive property access (`?.`)
- [ ] No try/catch in hot paths
- [ ] Matches existing integration patterns
- [ ] Simple and readable — no duplication or unnecessary special cases
