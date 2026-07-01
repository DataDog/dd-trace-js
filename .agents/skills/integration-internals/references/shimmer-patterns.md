# Shimmer Function-Type Patterns

When orchestrion cannot be used, shimmer wrapping must match the function type being wrapped. **Always include a comment explaining why orchestrion is not viable.**

## Synchronous Functions
```javascript
shimmer.wrap(obj, 'syncMethod', original => function (...args) {
  if (!startCh.hasSubscribers) return original.apply(this, args)

  const ctx = { args }

  return startCh.runStores(ctx, () => {
    try {
      const result = original.apply(this, args)
      ctx.result = result
      finishCh.publish(ctx)
      return result
    } catch (error) {
      ctx.error = error
      errorCh.publish(ctx)
      throw error
    }
  })
})
```

## Async/Promise Functions
```javascript
shimmer.wrap(obj, 'asyncMethod', original => function (...args) {
  if (!startCh.hasSubscribers) return original.apply(this, args)

  const ctx = { args }

  return startCh.runStores(ctx, () => {
    const promise = original.apply(this, args)

    return promise.then(
      result => {
        ctx.result = result
        finishCh.publish(ctx)
        return result
      },
      error => {
        ctx.error = error
        errorCh.publish(ctx)
        throw error
      }
    )
  })
})
```

## Callback Functions
```javascript
shimmer.wrap(obj, 'callbackMethod', original => function (...args) {
  if (!startCh.hasSubscribers) return original.apply(this, args)

  const ctx = { args }
  const callbackIndex = args.length - 1
  const originalCallback = args[callbackIndex]

  args[callbackIndex] = function (error, result) {
    if (error) {
      ctx.error = error
      errorCh.publish(ctx)
    } else {
      ctx.result = result
      finishCh.publish(ctx)
    }
    return originalCallback.apply(this, arguments)
  }

  return startCh.runStores(ctx, () => {
    return original.apply(this, args)
  })
})
```

## Handler/Event Pattern (Consumers)

For message consumers and event handlers — wrap the internal method that calls the handler, not the registration method:

```javascript
shimmer.wrap(consumer, '_processMessage', original => function (message) {
  if (!startCh.hasSubscribers) return original.apply(this, arguments)

  const ctx = { message }

  return startCh.runStores(ctx, () => {
    try {
      const result = original.apply(this, arguments)
      if (result?.then) {
        return result.then(
          r => { finishCh.publish(ctx); return r },
          e => { ctx.error = e; errorCh.publish(ctx); throw e }
        )
      }
      finishCh.publish(ctx)
      return result
    } catch (error) {
      ctx.error = error
      errorCh.publish(ctx)
      throw error
    }
  })
})
```

## Factory Pattern

When a library returns new instances from a factory function:

```javascript
shimmer.wrap(moduleExports, 'createClient', original => function (...args) {
  const client = original.apply(this, args)

  // Wrap methods on the returned instance
  shimmer.wrap(client, 'query', queryWrapper)

  return client
})
```

## addHook API

```javascript
addHook({
  name: 'package-name',           // npm package name (or array)
  versions: ['>=1.0.0', '<3.0'],  // semver ranges
  file: 'lib/client.js',          // optional: specific file within package
}, (moduleExports, version, name) => {
  // Patch moduleExports
  return moduleExports  // Must return!
})
```

## Preventing Double-Patching

```javascript
const PATCHED = Symbol('mylib.patched')

addHook({ name: 'mylib' }, (moduleExports) => {
  if (moduleExports[PATCHED]) return moduleExports
  moduleExports[PATCHED] = true

  // ... patching logic
  return moduleExports
})
```

## Common Mistakes

### Using publish() for Start Events
```javascript
// WRONG — loses async context
startCh.publish(ctx)
const result = original.apply(this, args)

// CORRECT — preserves context
return startCh.runStores(ctx, () => {
  return original.apply(this, args)
})
```

### Wrong Pattern for Function Type
```javascript
// WRONG — treating promise like sync
const result = original.apply(this, args)  // Returns promise!
finishCh.publish(ctx)
return result  // Span closes before promise resolves

// CORRECT — handle promise
return original.apply(this, args).then(result => {
  finishCh.publish(ctx)
  return result
})
```

### Forgetting to Return moduleExports
```javascript
// WRONG
addHook({ name: 'lib' }, (exports) => {
  shimmer.wrap(exports, 'method', ...)
  // Missing return!
})

// CORRECT
addHook({ name: 'lib' }, (exports) => {
  shimmer.wrap(exports, 'method', ...)
  return exports
})
```
