# Orchestrion

Read the exact vendored `@apm-js-collab/code-transformer` version reported by
`npm run verify:integration-skills`; unpack that release when bundled output is insufficient. Do not infer its
configuration from this reference.

Start from the closest current entry under
`packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/`, then verify every selector against the
published upstream artifact.

## Selection

- Match the source function that owns the work, not a decorated runtime handle that calls it.
- Use the narrowest function query. Receiver-sensitive assignments need both the object and property constraints.
- Add separate entries for distinct CJS and ESM implementations.
- Use a raw AST query only when the function query cannot express the source shape.
- Use a custom transform only after inspecting the current built-ins and generated wrapper.

## Lifecycle

- `Sync` covers a synchronous return or throw.
- `Async` covers sync or promise return while preserving Promise-subclass and thenable identity.
- `Callback` wraps the configured callback argument.
- `Auto` selects callback or promise behavior at runtime.
- `returnKind` additionally instruments iterator operations on a second channel.

Orchestrion publishes `end` when the source call returns and asynchronous completion later. It does not publish
`finish`. Finish a synchronous span from `end` and an unsettled promise/callback span from `asyncEnd`; keep the
result/error presence gate when both paths share one handler.

The context carries the applied argument array and later the result or error. Non-arrow targets expose the receiver
at start; arrow targets expose it only by `end`. Mutating the argument array changes what the source function
receives.

Native promises can accept a replacement resolved value through the completion context. Promise subclasses and
thenables are side-chained and returned unchanged, so use shimmer when their resolved value or returned identity
must be wrapped.

## Cost and verification

The generated wrapper performs setup before its subscriber gate. Inspect or benchmark an extremely hot inactive
method before claiming zero overhead.

Test every configured file path and operator against the real installed package. For iterators, test the initial
call and the second operation channel. For a custom transform, test its generated source shape and both CJS and ESM
matcher registration.
