'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const legacyStorage = storage('legacy')

// graphql-js >=17 publishes a native `graphql:resolve` diagnostics_channel for every field
// resolution (see utils.js' `subscribeToPrefix` doc comment for why orchestrion can't reach
// graphql-js internals on that line, and execute.js' `#bindStartNative` for the sibling
// execute-span path). Unlike the pre-17 line, there is no schema to monkey-patch here: this
// plugin creates graphql.resolve spans directly off the channel, one subscription covering
// every resolver graphql-js calls.
//
// The payload has no AST/ResolveInfo access, which caps parity with the pre-17 implementation:
//   - `graphql.source` (the field's source text) is never set — there is no field node to
//     read a location off of;
//   - per-resolve `graphql.variables.<name>` tagging is not implemented — that feature
//     correlates a field argument back to an *operation* variable via the field's AST, which
//     isn't reachable here (the channel's `args` are already-resolved values, not AST nodes);
//   - collapsed spans are not disambiguated by schema coordinate for polymorphic (interface/union)
//     list fields — a collapsed path is deduplicated by path alone, not path + concrete type.
//
// Parent/child nesting between resolve spans is NOT free via AsyncLocalStorage, unlike the
// execute -> root-field case: graphql-js' `traceMixed` only brackets the resolver *function call*
// with `channel.start.runStores(...)` — value completion and any nested-selection recursion for
// object/list results run afterward, once that call has already returned (synchronously for a sync
// resolver; in a `.then()` scheduled outside the bracket for an async one). So a field's own
// AsyncLocalStorage context never covers its children's resolution, and this plugin looks the
// parent span up explicitly instead, through `graphqlFieldSpans` (allocated once per operation by
// execute.js's native bindStart, keyed by field path).
class GraphQLResolvePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'resolve'
  static type = 'graphql'
  static prefix = 'tracing:graphql:resolve'

  bindStart (ctx) {
    const parentStore = legacyStorage.getStore()
    ctx.parentStore = ctx.currentStore = parentStore

    if (this.config.depth === 0) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const { fieldName, parentType, fieldType, fieldPath } = ctx

    if (!isWithinDepth(this.config, fieldPath)) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const collapse = this.config.collapse
    const path = collapse ? collapseListIndices(fieldPath) : fieldPath
    const fieldSpans = parentStore?.graphqlFieldSpans
    const parentKey = getParentKey(fieldPath, collapse)
    const parentSpan = parentKey === undefined ? parentStore?.span : fieldSpans?.get(parentKey)?.span

    const existing = collapse ? fieldSpans?.get(path) : undefined

    if (existing) {
      // Non-first collapsed sibling. Each resolver call is bracketed by its own independent
      // start/end, so the first occurrence's own graphql.resolve span already finished by the
      // time this one starts (there is no "last sibling" signal to wait for) — run this sibling's
      // resolver in the store captured before the *first* occurrence started instead of
      // re-entering the closed span, matching the pre-17 implementation's same constraint (see
      // the `callInAsyncScope`/`field.parentStore` comment in the pre-17 execute.js). That
      // captured store's own span is an ancestor that had not exited yet when the first
      // occurrence began, so — unlike this field's own span, or its immediate parent field's,
      // both of which close as soon as their resolver function returns rather than staying open
      // through their children's resolution — it is still guaranteed to be live.
      ctx.ddSkipped = true
      ctx.currentStore = existing.parentStore
      return ctx.currentStore
    }

    const baseTypeName = fieldType.replace(/[[\]!]/g, '')

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      childOf: parentSpan,
      resource: `${fieldName}:${fieldType}`,
      type: 'graphql',
      meta: {
        'graphql.field.coordinates': `${parentType}.${fieldName}`,
        'graphql.field.name': fieldName,
        'graphql.field.path': path,
        'graphql.field.type': baseTypeName,
      },
    }, ctx)

    fieldSpans?.set(path, { span, parentStore })
    ctx.ddPath = path

    return ctx.currentStore
  }

  end (ctx) {
    // Synchronous resolver: `result`/`error` are already on `ctx`. An async resolver leaves
    // both unset here — `asyncEnd` carries them once the returned promise settles, matching
    // graphql-js' own tracingChannel contract (see graphql's diagnostics.js `traceMixed`).
    if (Object.hasOwn(ctx, 'result') || Object.hasOwn(ctx, 'error')) {
      this.#finish(ctx)
    }

    return ctx.parentStore
  }

  asyncEnd (ctx) {
    this.#finish(ctx)
    return ctx.parentStore
  }

  error (ctx) {
    if (ctx.ddSkipped) return
    const span = ctx?.currentStore?.span
    if (span && ctx?.error) span.setTag('error', ctx.error)
  }

  #finish (ctx) {
    if (ctx.ddSkipped) return

    const { result, error } = ctx
    const span = ctx?.currentStore?.span ?? this.activeSpan
    if (!span) return

    if (error) span.setTag('error', error)

    if (this.config.hooks.resolve) {
      this.config.hooks.resolve(span, {
        fieldName: ctx.fieldName,
        path: ctx.ddPath,
        error: error || null,
        result: typeof result?.then === 'function' ? undefined : result,
      })
    }

    span.finish()
  }
}

// config.depth < 0 means no limit. Mirrors the pre-17 `shouldInstrumentNode`: only
// selection-set (non-numeric) segments count toward depth unless `countListIndices`.
function isWithinDepth (config, fieldPath) {
  if (config.depth < 0) return true

  let depth = 0
  for (const segment of fieldPath.split('.')) {
    if (config.countListIndices || !/^\d+$/.test(segment)) depth++
  }

  return config.depth >= depth
}

// The key of the field that should parent this one's span: the raw path with its own (always
// trailing, always non-numeric) name segment dropped, then any further trailing list-index
// segments dropped too, since a list index is an execution artifact with no span of its own —
// `friends.0.name`'s parent is `friends`, not `friends.0`. Returns undefined for a root field,
// whose parent is the operation's execute span instead (found via the ambient store).
function getParentKey (fieldPath, collapse) {
  const segments = fieldPath.split('.')
  segments.pop()

  while (segments.length && /^\d+$/.test(segments[segments.length - 1])) {
    segments.pop()
  }

  if (segments.length === 0) return undefined

  const parentPath = segments.join('.')
  return collapse ? collapseListIndices(parentPath) : parentPath
}

function collapseListIndices (fieldPath) {
  return fieldPath.replaceAll(/(^|\.)\d+(?=\.|$)/g, '$1*')
}

module.exports = GraphQLResolvePlugin
