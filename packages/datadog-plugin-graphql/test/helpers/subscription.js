'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

/**
 * @param {typeof import('graphql')} graphql
 * @param {typeof import('graphql').execute} execute
 * @param {typeof import('graphql').subscribe} subscribe
 * @param {boolean} asyncSetup
 */
async function assertSubscriptionDelivery (graphql, execute, subscribe, asyncSetup) {
  const tracer = require('../../../dd-trace')
  const schema = graphql.buildSchema('type Query { outer: String } type Subscription { event(label: String): String }')
  const document = graphql.parse('subscription ($label: String) { event(label: $label) }')
  const contextValue = Object.freeze({})
  const variableValues = Object.freeze({ label: 'delivery' })
  const typeResolver = () => 'Subscription'
  const spans = []
  const checkedFields = []
  const iastLabels = []
  const deliveryArgs = []
  tracer.use('graphql', {
    hooks: {
      execute (span, args, result) {
        if (result?.data?.event !== undefined) deliveryArgs.push(args)
      },
    },
  })
  let sourceClosed = false
  let setupCalls = 0

  const field = schema.getSubscriptionType().getFields().event
  async function * source () {
    try {
      yield 'first'
      yield 'second'
      yield 'unused'
    } finally {
      sourceClosed = true
    }
  }
  field.subscribe = () => {
    setupCalls++
    const stream = source()
    return asyncSetup ? Promise.resolve(stream) : stream
  }
  field.resolve = payload => {
    spans.push(tracer.scope().active())
    return payload
  }

  schema.getQueryType().getFields().outer.resolve = async () => {
    const subscription = subscribe({ schema, document, contextValue, variableValues, typeResolver })
    assert.strictEqual(setupCalls, 1)
    assert.strictEqual(typeof subscription.then === 'function', asyncSetup)
    const events = await subscription
    try {
      const first = await events.next()
      const second = await events.next()
      assert.strictEqual(first.done, false)
      assert.strictEqual(second.done, false)
      return [first.value.data.event, second.value.data.event].join(',')
    } finally {
      await events.return()
    }
  }

  const resolverChannel = dc.channel('datadog:graphql:resolver:start')
  const iastChannel = dc.channel('apm:graphql:resolve:start')
  const check = ({ info }) => checkedFields.push(info.fieldName)
  const taint = ({ args }) => iastLabels.push(args.label)
  resolverChannel.subscribe(check)
  iastChannel.subscribe(taint)
  try {
    const result = await execute({ schema, document: graphql.parse('{ outer }'), contextValue })
    assert.strictEqual(result.errors, undefined)
    assert.strictEqual(result.data.outer, 'first,second')
    assert.strictEqual(sourceClosed, true)
    assert.deepStrictEqual(checkedFields, ['outer', 'event', 'event'])
    assert.deepStrictEqual(iastLabels, [undefined, 'delivery', 'delivery'])
    assert.strictEqual(deliveryArgs.length, 2)
    for (const args of deliveryArgs) {
      assert.strictEqual(args.document, document, 'the execute hook receives the original document')
      assert.strictEqual(args.variableValues, variableValues, 'the execute hook receives the raw input variables')
      assert.strictEqual(args.typeResolver, typeResolver, 'the execute hook receives the original type resolver')
    }
    assert.deepStrictEqual(spans.map(span => span?.context().getTag('resource.name')), ['event:String', 'event:String'])
    assert.notStrictEqual(spans[0].context().toSpanId(), spans[1].context().toSpanId())
  } finally {
    iastChannel.unsubscribe(taint)
    resolverChannel.unsubscribe(check)
    tracer.use('graphql', { hooks: {} })
  }
}

module.exports = assertSubscriptionDelivery
