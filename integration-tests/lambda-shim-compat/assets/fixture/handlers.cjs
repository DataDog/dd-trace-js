'use strict'

const tracer = require('dd-trace')

const { EventEmitter } = require('node:events')

const scenario = process.env.COMPAT_CASE
const shim = process.env.COMPAT_ENTRY.startsWith('layer')
  ? require('/opt/nodejs/node_modules/datadog-lambda-js')
  : require('datadog-lambda-js')
const response = { statusCode: 200, body: 'compatibility-ok' }
let invocation = 0

function observe () {
  invocation++
  const span = tracer.scope().active()
  console.log(JSON.stringify({
    compat: 'inside',
    invocation,
    span: span?.context().toSpanId(),
    headers: shim.getTraceHeaders(),
  }))
  shim.sendDistributionMetric('compat.custom', 1, 'test:compatibility')
  if (scenario.startsWith('timeout')) {
    tracer.startSpan('compat.unfinished', { childOf: span })
  } else if (span) {
    tracer.trace('compat.child', () => {})
  }
}

function createHandler () {
  if (scenario.startsWith('stream')) {
    const handler = (event, stream, context) => {
      observe()
      if (context.functionName !== 'legacy-lambda-compat') throw new Error('streaming context shifted')
      if (scenario === 'stream-throw') throw new Error('expected failure')
      if (scenario === 'stream-reject') return Promise.reject(new Error('expected failure'))
      stream.emit('drain')
      stream.end('streamed')
      return Promise.resolve('streamed')
    }
    handler[Symbol.for('aws.lambda.runtime.handler.streaming')] = 'response'
    return handler
  }

  if (['callback', 'callback-error', 'race-callback', 'race-promise', 'timeout-callback'].includes(scenario)) {
    return function (event, context, callback) {
      observe()
      if (scenario === 'timeout-callback') return 'incidental'
      if (scenario === 'callback-error') {
        setImmediate(() => callback(new Error('expected failure')))
        return 'incidental'
      }
      if (scenario === 'race-promise') {
        setTimeout(() => callback(null, 'loser'), 20)
        return Promise.resolve(response)
      }
      setImmediate(() => callback(null, response))
      if (scenario === 'race-callback') return new Promise(resolve => setTimeout(() => resolve('loser'), 20))
      return 'incidental'
    }
  }

  return function (event, context) {
    observe()
    switch (scenario) {
      case 'throw': throw new Error('expected failure')
      case 'reject': return Promise.reject(new Error('expected failure'))
      case 'warm-reject':
        return invocation === 1 ? Promise.reject(new Error('expected failure')) : Promise.resolve(response)
      case 'done': setImmediate(() => context.done(null, response)); return
      case 'succeed': setImmediate(() => context.succeed(response)); return
      case 'fail': setImmediate(() => context.fail(new Error('expected failure'))); return
      case 'artifact': setImmediate(() => context.succeed(response)); return new EventEmitter()
      case 'timeout-context': return new EventEmitter()
      case 'timeout-frozen':
      case 'timeout-promise':
      case 'timeout-plugin-disabled': return new Promise(() => {})
      case 'promise': return Promise.resolve(response)
      default: return response
    }
  }
}

exports.createHandler = createHandler
exports.response = response
