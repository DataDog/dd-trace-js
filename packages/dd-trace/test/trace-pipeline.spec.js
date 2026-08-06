'use strict'

const assert = require('node:assert/strict')

const msgpack = require('@msgpack/msgpack')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('./plugins/agent')

describe('trace pipeline wire contract', () => {
  let tracer

  beforeEach(async () => {
    tracer = await agent.load([])
  })

  afterEach(() => agent.close())

  it('preserves trace structure and canonical span fields', async () => {
    const assertion = agent.assertSomeTraces(traces => {
      assert.strictEqual(traces.length, 1)
      assert.strictEqual(traces[0].length, 2)

      const root = traces[0].find(span => span.resource === 'pipeline.root.resource')
      const child = traces[0].find(span => span.resource === 'pipeline.child.resource')
      assert.notStrictEqual(root, undefined)
      assert.notStrictEqual(child, undefined)
      assert.strictEqual(root.name, 'pipeline.root')
      assert.strictEqual(root.service, 'pipeline-service')
      assert.strictEqual(root.type, 'custom')
      assert.strictEqual(root.parent_id, 0n)
      assert.strictEqual(child.trace_id, root.trace_id)
      assert.strictEqual(child.parent_id, root.span_id)
      assert.strictEqual(typeof root.start, 'bigint')
      assert.ok(typeof root.duration === 'bigint' || Number.isSafeInteger(root.duration))
      assert.ok(root.duration >= 0)
      assert.strictEqual(root.meta['string.tag'], 'value')
      assert.strictEqual(root.metrics['boolean.tag'], 1)
      assert.strictEqual(root.metrics['numeric.tag'], 42)
      assert.strictEqual(root.meta['remove.me'], undefined)
      assert.strictEqual(root.meta['_dd.base_service'], 'test')
      assert.strictEqual(child.error, 1)
      assert.strictEqual(child.meta['error.type'], 'Error')
      assert.strictEqual(child.meta['error.message'], 'child failed')
      assert.match(child.meta['error.stack'], /Error: child failed/)
    }, { spanResourceMatch: /pipeline\.root\.resource/ })

    const root = tracer.startSpan('pipeline.root', {
      tags: {
        'boolean.tag': true,
        'numeric.tag': 42,
        'remove.me': 'initial',
        'resource.name': 'pipeline.root.resource',
        'service.name': 'pipeline-service',
        'span.type': 'custom',
        'string.tag': 'value',
      },
    })
    root.setTag('remove.me', null)
    const child = tracer.startSpan('pipeline.child', {
      childOf: root,
      tags: { 'resource.name': 'pipeline.child.resource' },
    })
    child.setTag('error', new Error('child failed'))
    child.finish()
    root.finish()

    await assertion
  })

  it('preserves events, links, and structured metadata', async () => {
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.deepStrictEqual(msgpack.decode(span.meta_struct['pipeline.struct']), {
        nested: { value: 42 },
      })
      assert.deepStrictEqual(agent.unformatSpanEvents(span), [{
        name: 'pipeline.event',
        startTime: 1234,
        attributes: { count: 2, success: true },
      }])

      const links = JSON.parse(span.meta['_dd.span_links'])
      assert.strictEqual(links.length, 1)
      assert.strictEqual(links[0].trace_id, span.meta['_dd.p.tid'] + span.trace_id.toString(16).padStart(16, '0'))
      assert.strictEqual(links[0].span_id, span.span_id.toString(16).padStart(16, '0'))
      assert.deepStrictEqual(links[0].attributes, { reason: 'self' })
    }, { spanResourceMatch: /pipeline\.data/ })

    const span = tracer.startSpan('pipeline.data', {
      tags: { 'resource.name': 'pipeline.data' },
    })
    span.meta_struct = {
      'pipeline.struct': { nested: { value: 42 } },
    }
    span.addEvent('pipeline.event', { count: 2, success: true }, 1234)
    span.addLink({ context: span.context(), attributes: { reason: 'self' } })
    span.finish()

    await assertion
  })

  it('exports partial chunks and later exports the active root once', async () => {
    await agent.close()
    tracer = await agent.load([], {}, { flushMinSpans: 2 })

    const partialAssertion = agent.assertSomeTraces(traces => {
      assert.strictEqual(traces.length, 1)
      assert.strictEqual(traces[0].length, 2)
      assert.deepStrictEqual(
        traces[0].map(span => span.resource).sort(),
        ['pipeline.child.1', 'pipeline.child.2']
      )
    }, { spanResourceMatch: /pipeline\.child/ })

    const root = tracer.startSpan('pipeline.root', {
      tags: { 'resource.name': 'pipeline.partial.root' },
    })
    const firstChild = tracer.startSpan('pipeline.child', {
      childOf: root,
      tags: { 'resource.name': 'pipeline.child.1' },
    })
    const secondChild = tracer.startSpan('pipeline.child', {
      childOf: root,
      tags: { 'resource.name': 'pipeline.child.2' },
    })
    firstChild.finish()
    secondChild.finish()
    await partialAssertion

    const rootAssertion = agent.assertFirstTraceSpan({ resource: 'pipeline.partial.root' }, {
      spanResourceMatch: /pipeline\.partial\.root/,
    })
    root.finish()
    await rootAssertion
  })
})
