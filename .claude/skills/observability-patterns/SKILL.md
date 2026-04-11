---
name: observability-patterns
description: |
  What to instrument for each library category and how it affects hooking strategy.
  Language-agnostic patterns applicable to all dd-trace implementations. Use when:
  deciding which methods to trace, understanding hook strategies per category,
  distinguishing registration from invocation, or finding the right instrumentation
  target. Triggers: "what to instrument", "what to trace", "which methods", "hook
  strategy", "wrap function", "database tracing", "messaging tracing", "http tracing",
  "cache tracing", "producer consumer", "streaming", "logging plugin", "orm tracing",
  "graphql", "grpc", "web framework", "handler invocation", "registration vs invocation",
  "job queue", "ai agent", "llm tracing".
---

# Observability Patterns

## Goal

Instrument to provide customer value:
- **Performance visibility** - Where time is spent
- **Error detection** - When things fail and why
- **Distributed tracing** - Follow requests across services
- **Resource attribution** - Which operations hit which resources

## Avoid Over-Instrumentation

**Limit instrumentation to the core functionality of the library.** Too many spans create noise and hurt performance.

**DO instrument:**
- Primary I/O operations (queries, requests, message sends)
- Operations customers need visibility into
- Entry/exit points for distributed tracing

**DON'T instrument:**
- Every internal helper method
- Utility functions that don't represent meaningful work
- Multiple spans for the same logical operation
- Operations that complete in microseconds

**Rule of thumb:** If a span wouldn't help a customer debug a production issue or understand performance, don't create it.

## Quick Reference

| Category | What to Trace | Hook Strategy |
|----------|---------------|---------------|
| Database | Query execution | Wrap query/execute methods |
| Cache | Get/set/delete | Wrap command methods |
| HTTP Client | Request execution | Wrap request method |
| HTTP Server | Request handling | Wrap internal handler, NOT route registration |
| Messaging Producer | Message send | Wrap send/publish + inject context |
| Messaging Consumer | Handler invocation | Wrap internal dispatch, NOT registration |
| Job Queue | Add job + process job | Producer + consumer patterns |
| LLM/AI | API calls | Wrap completion methods, handle streaming |
| AI Agent | Runs + tool calls | Wrap run + internal step execution |
| Logging | Log emission | Wrap log methods to inject trace IDs |
| Testing | Test execution | Wrap lifecycle hooks, NOT definition |
| ORM | Query execution | Wrap where query hits underlying DB |
| GraphQL | Execute + resolve | Wrap execution phases |
| gRPC | RPC calls | Wrap call methods (client) + handler invocation (server) |
| Streaming | Stream lifecycle | Wrap creation + completion |

## Key Principle: Registration vs Invocation

**Critical for servers, consumers, job processors, and any callback-based API.**

| Stage | Example | Hook? |
|-------|---------|-------|
| Registration | `app.get('/path', handler)` | NO - runs once at startup |
| Registration | `consumer.on('message', fn)` | NO - just stores function |
| Registration | `worker.process(handler)` | NO - just stores handler |
| Invocation | `router._handle(req, res)` | YES - runs per request |
| Invocation | `consumer._processMessage(msg)` | YES - runs per message |
| Invocation | `worker._executeJob(job)` | YES - runs per job |

Registration stores a function. Invocation does the work. **Always hook invocation.**

## Finding the Right Method

1. **Follow the data flow** - Where does the request actually go out?
2. **Look for I/O** - Network calls, file operations
3. **Check frequency** - Per-operation vs once at startup
4. **Consider duration** - Span should represent real work

## Red Flags - Wrong Target

- Method only called once at startup
- Method doesn't perform I/O
- Method returns a builder/factory
- Method is sync in an async library
- Span wouldn't represent meaningful work

## Advanced Patterns

### Capturing Config from Setup Methods

When traced method lacks needed data:

```
// Hook setup to capture config
wrap(Client, 'connect', orig => function(opts) {
  this._dbName = opts.database  // Store
  return orig.apply(this, arguments)
})

// Access in traced method
wrap(Client, 'query', orig => function(sql) {
  const dbName = this._dbName   // Use stored data
})
```

### Factory Patterns

```
wrap(module, 'createClient', orig => function(...args) {
  const client = orig.apply(this, args)
  wrap(client, 'query', queryWrapper)  // Wrap returned instance
  return client
})
```

### Streaming Pattern

```
// Start span when stream created
stream = createStream()    → Start span

// Keep span open during streaming
stream.on('data', ...)     → Accumulate data

// Finish span when complete
stream.on('end', ...)      → Set final tags, finish span
stream.on('error', ...)    → Finish with error
```

## Detailed Patterns by Category

For detailed what-to-trace/skip and hook strategies per category, see:
- `references/integration-patterns.md` - Full patterns for all 14 integration types

## Related Skills

- **Tag conventions** - See `datadog-semantics` skill
- **Writing plugins** - See `plugins` skill
- **Reference implementations** - See `reference-integrations` skill
