# GraphQL JIT instrumentation

## The problem

`graphql-jit` compiles a GraphQL document into JavaScript. It then runs the generated query function for each request.

Normal GraphQL instrumentation observes the execution function and resolver calls. The generated query bypasses the execution function. It also replaces default resolvers with direct property reads.

The integration must therefore change code at two levels:

```text
graphql-jit compiler source
  -> Orchestrion AST transforms
rewritten compiler
  -> compileQuery(document)
generated query with Datadog calls
  -> request
GraphQL plugin runtime
```

## The three stages

| Stage | Code that runs | Result |
| --- | --- | --- |
| Compiler load | Orchestrion selectors and transforms | A compiler that can record fields and emit Datadog calls |
| Query compilation | The rewritten compiler and `ddTraceRuntime` | A bound query and its compact `ddPlan` |
| Request execution | The generated query and the GraphQL plugin | A request-owned `rootCtx`, field state, and spans |

## What Orchestrion changes

Orchestrion applies the instrumentation entries in order. Some entries wrap a function with the standard synchronous lifecycle. Other entries change the matched AST directly.

| Compiler point | Change | Purpose |
| --- | --- | --- |
| `buildCompilationContext` | Publish the returned compilation context | Let the plugin attach `ddTraceRuntime` and an empty `ddTracePlan` |
| `compileObjectType` | Add a branch for an inlined default field | Replace its generated property read with a guarded runtime call |
| `compileDeferredField` | Validate and replace the generated resolver call, then add error recording | Preserve field identity and per-invocation failures after the compiler hoists the resolver |
| `createBoundQuery` | Finalize the plan and add `ddTrace` to the generated execution context | Connect reusable compilation data to one request |
| The returned query | Add the standard execution wrapper, then adjust that wrapper | Give the plugin the document, schema, plan, and resolver map |

The returned-query transforms depend on this order. The standard wrapper first creates `__apm$ctx`, `__apm$traced`, and `__apm$wrapped`.

`configureGraphqlJitExecute` then finds these generated nodes. It adds the bound query metadata to `__apm$ctx`.

The transform also moves `__apm$wrapped` into the `createBoundQuery` scope. It then removes the per-request `__apm$traced` closure.

Both branches call `__apm$wrapped` with the original `this` value and argument values. The returned query does not retain `compilationContext`.

Finally, the transform moves the subscriber check before tracing setup. The no-subscriber branch reaches `__apm$wrapped` before any Orchestrion tracing setup.

The selectors match private functions by name, parameter names, and required AST structure. Each transform also asserts the nested structure that it changes.

These checks make an unknown compiler shape fail the rewrite. They prevent a partial transform from emitting invalid query code.

## How state crosses the stages

`createGraphqlJitRuntime` creates the bridge between instrumentation and the plugin. The plugin supplies the field, resolver, and execution callbacks that the bridge exposes.

The `buildCompilationContext` completion subscriber calls `configureCompilationContext`. This function attaches the bridge and a building plan to the returned compiler context.

The rewritten compiler calls the bridge while it generates a query. It records field descriptors and emits calls back to the same bridge.

`finalizeCompilation` replaces temporary parent path keys with descriptor IDs.

The compilation plan changes names as it crosses each boundary:

```text
compilationContext.ddTracePlan  mutable plan during compilation
  -> finalizeCompilation()
ddPlan                          compact plan closed over by the bound query
  -> Orchestrion execution context
ctx.ddPlan                      plan received by the execution plugin
  -> createRootContext()
rootCtx.jitPlan                 per-request reference to the shared compact plan
```

The bound query can reuse `ddPlan` for every request because it contains no request values.

At request start, the execution subscriber creates `rootCtx`. It puts this object in the active async store before it calls the bound query.

The generated execution context contains this injected property:

```js
ddTrace: ddTraceRuntime?.startExecution(parsedVariables.coerced)
```

`startExecution` reads `rootCtx` from the active store. It adds the coerced variables and runtime bridge, then returns the same object.

The request state follows a separate chain:

```text
activeStore.graphqlRootCtx
  -> startExecution(parsedVariables.coerced)
  -> executionContext.ddTrace (the same rootCtx)
```

`compilationContext.ddTraceRuntime` provides `startExecution` to the generated query. Field code reaches request state through `__context.ddTrace`.

The field code reaches compilation data through `rootCtx.jitPlan`.

## Why fields need two rewrites

`graphql-jit` generates two field shapes. The integration cannot instrument both shapes at one common function boundary.

| Field shape | Generated operation | Datadog connection | Runtime entry |
| --- | --- | --- | --- |
| Deferred resolver call | Guarded call through the hoisted resolver map | Generated dispatch contains the descriptor ID | `resolveCompiledJitField` |
| Inlined default property read | Direct read from the parent result | A conditional expression surrounds the original read | `resolveJitDefaultInvocation` |

These names describe the generated shapes. `alwaysDefer` can create a resolver call for a field that originally used default resolution.

### Deferred resolver calls

`graphql-jit` puts each resolver call in its deferred list. Later, `compileDeferredField` writes the call into the generated query source.

`configureGraphqlJitDeferredField` validates the call template and inserts `registerField` before the source is built.
It passes the source, resolver name, and descriptor ID to `compileResolverCall`.

For a registered field, `compileResolverCall` restores the original resolver in the map. The generated fast path calls that resolver directly.

When observation is active, the generated branch calls `resolveCompiledJitField` with the descriptor ID and original resolver.
The compiler error branches call `recordResolverError` with the same descriptor ID.

When field registration fails, `compileResolverCall` keeps the generated call. It wraps that resolver for normal GraphQL instrumentation.

### Inlined default property reads

This generated shape has no resolver function to wrap. `graphql-jit` writes a property expression such as `parent.userName` into the query source.

`configureGraphqlJitCompileObject` detects this compiler branch. It calls `compileDefaultField` with the original compiled expression and the compiler-owned argument data.

`compileDefaultField` finds the property expression and replaces only that read. The replacement has this logical shape:

```text
request needs observation
  ? resolveJitDefaultInvocation(rootCtx, descriptorId, parent, path, arguments)
  : original property read
```

The false branch preserves the code that `graphql-jit` generated. The true branch lets the runtime create or reuse field state before the read.

`jitTraceFirst` creates field state once per collapsed descriptor and request. Later reads use the stored field context without rebuilding resolver arguments. `jitTraceAll` enters runtime for every invocation that needs observation.

## What a field descriptor represents

A descriptor identifies one static field selection in the compiled document. It does not identify one request or one list item.

`analyzeCompilerPath` converts the compiler's linked response path into several forms:

| Descriptor value | Use |
| --- | --- |
| `collapsedPath` | Stable span path with dynamic list positions replaced by `*` |
| `runtimePath` | JavaScript expression that builds the concrete path during execution |
| `parentPathKey` | Temporary link to the nearest parent selection during compilation |
| `parentId` | Compact parent descriptor link after finalization |
| `pathDepth` | Depth that includes dynamic list positions |
| `selectionDepth` | Depth that counts only GraphQL selections |

For example, these executions use one descriptor:

```text
users.0.profile.name
users.1.profile.name
```

Their collapsed path is `users.*.profile.name`. Uncollapsed tracing combines the descriptor ID with each concrete runtime path.

This split lets one compiled plan serve all list items. It also lets configuration decide whether list positions count toward the resolver depth.

Both paths resolve a `JitFieldDescriptor` from `rootCtx.jitPlan`. The deferred dispatch passes the descriptor ID to `resolveCompiledJitField`.

`resolveJitDefaultInvocation` performs the lookup internally.

## Field arguments

The compiler has already applied GraphQL defaults and coercion before Datadog records a field. Reinterpreting the document would duplicate this behavior.

For inlined default property reads, `compileArgumentFactory` starts with the compiler-generated argument object. It records static values and variable-dependent paths.

The helper adds one named factory to the compiler's hoisted functions. At execution time, that factory patches only the variable-dependent paths.

## Request-state lifetime

The execution wrapper retains `rootCtx` until execution finishes. `releaseRootContext` then clears references that copied async stores can retain.
