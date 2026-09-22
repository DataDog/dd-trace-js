'use strict'

/**
 * Shared input dimensions for capture and real-provider evaluation benchmarks.
 * @param {string} shape
 */
function evaluationContext (shape) {
  const context = { targetingKey: 'benchmark-customer', country: 'US', plan: 'pro', age: 32 }
  if (shape === 'scale') {
    for (let i = 0; i < 256; i++) context['field' + i] = 'value-' + i
  } else if (shape === 'stress') {
    for (let i = 0; i < 10_000; i++) context['field' + i] = { nested: ['x'.repeat(512), i] }
  } else if (shape === 'hostile') {
    context.cycle = context
    context.array = new Array(1_000_000).fill('value')
    context.hostile = {}
    Object.defineProperty(context.hostile, 'accessor', {
      enumerable: true,
      get () { throw new Error('must not read') },
    })
    context.proxy = new Proxy({}, { ownKeys () { throw new Error('hostile enumeration') } })
  }
  return context
}

module.exports = { evaluationContext }
