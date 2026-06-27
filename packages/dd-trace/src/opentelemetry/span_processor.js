'use strict'

const nomenclature = require('../service-naming')
const { RESOURCE_NAME } = require('../../../../ext/tags')

// `next.span_type` value Next.js sets on its root request span. The bridge owns
// no other knowledge of Next; this single string is the whole detection surface.
const NEXT_BASE_SERVER_HANDLE_REQUEST = 'BaseServer.handleRequest'

class NoopSpanProcessor {
  forceFlush () {
    return Promise.resolve()
  }

  onStart (span, context) {}
  onEnd (span) {}

  shutdown () {
    return Promise.resolve()
  }
}

class MultiSpanProcessor extends NoopSpanProcessor {
  constructor (spanProcessors) {
    super()
    this._processors = spanProcessors
  }

  forceFlush () {
    return Promise.all(
      this._processors.map(p => p.forceFlush())
    )
  }

  onStart (span, context) {
    for (const processor of this._processors) {
      processor.onStart(span, context)
    }
  }

  onEnd (span) {
    for (const processor of this._processors) {
      processor.onEnd(span)
    }
  }

  shutdown () {
    return Promise.all(
      this._processors.map(p => p.shutdown())
    )
  }
}

/**
 * Corrects Datadog operation name and resource for Next.js' own OTel root request span.
 *
 * Next names that span after the HTTP method and, at request finish, calls `updateName`
 * with `${method} ${route}`. The bridge's `updateName` follows OTel-default semantics and
 * routes that into the DD operation name, leaving the resource as the bare method — the
 * reverse of Datadog's contract (stable operation name, route-bearing resource). This
 * processor is installed by the `TracerProvider` unconditionally so the correction needs
 * no user-registered processor and cannot be bypassed.
 *
 * The writes go straight to the DD span context: `Span.end()` finishes the DD span before
 * `onEnd`, so `_duration` is set and the `isWritable`-gated OTel helpers would no-op.
 * `setTag` and `_name` are not gated, and `span_format.js` reads `_name` and the
 * `resource.name` tag at serialization time, which happens later in the writer.
 */
class NextSpanProcessor extends NoopSpanProcessor {
  /**
   * @param {import('./span')} span
   */
  onEnd (span) {
    const ddSpan = span._ddSpan
    const tags = ddSpan.context().getTags()
    if (tags['next.span_type'] !== NEXT_BASE_SERVER_HANDLE_REQUEST) return

    const method = tags['http.method']
    const route = tags['next.route'] ?? tags['http.route']
    // Next already wrote the RSC-aware `${method} ${route}` into `next.span_name`; prefer it
    // so we mirror Next's own naming, and only construct the resource when it is absent.
    const resource = tags['next.span_name'] ?? (route ? `${method} ${route}` : method)

    ddSpan.context()._name = nomenclature.opName('web', 'server', 'next')
    ddSpan.setTag(RESOURCE_NAME, resource)
  }
}

module.exports = {
  MultiSpanProcessor,
  NextSpanProcessor,
  NoopSpanProcessor,
}
