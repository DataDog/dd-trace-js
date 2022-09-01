'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class MongodbCorePlugin extends Plugin {
  static get name () {
    return 'mongodb-core'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:mongodb:query:start`, ({ ns, ops, options, name }) => {
      const query = getQuery(ops)
      const resource = truncate(getResource(ns, query, name))
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('mongodb.query', {
        childOf,
        tags: {
          'service.name': this.config.service || `${this.tracer._service}-mongodb`,
          'resource.name': resource,
          'span.type': 'mongodb',
          'span.kind': 'client',
          'db.name': ns
        }
      })

      if (query) {
        span.setTag('mongodb.query', query)
      }

      if (options && options.host && options.port) {
        span.addTags({
          'out.host': options.host,
          'out.port': options.port
        })
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:mongodb:query:error`, err => {
      storage.getStore().span.setTag('error', err)
    })

    this.addSub(`apm:mongodb:query:finish`, () => {
      storage.getStore().span.finish()
    })
  }
}

function getQuery (cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return
  if (cmd.query) return JSON.stringify(limitDepth(cmd.query))
  if (cmd.filter) return JSON.stringify(limitDepth(cmd.filter))
}

function getResource (ns, query, operationName) {
  const parts = [operationName, ns]

  if (query) {
    parts.push(query)
  }

  return parts.join(' ')
}

function truncate (input) {
  return input.slice(0, Math.min(input.length, 10000))
}

function shouldSimplify (input) {
  return !isObject(input)
}

function shouldHide (input) {
  return Buffer.isBuffer(input) || typeof input === 'function'
}

function limitDepth (input) {
  if (isBSON(input)) {
    input = input.toJSON()
  }

  if (shouldHide(input)) return '?'
  if (shouldSimplify(input)) return input

  const output = {}
  const queue = [{
    input,
    output,
    depth: 0
  }]

  while (queue.length) {
    const {
      input, output, depth
    } = queue.pop()
    const nextDepth = depth + 1
    for (const key in input) {
      if (typeof input[key] === 'function') continue

      let child = input[key]

      if (isBSON(child)) {
        child = child.toJSON()
      }

      if (depth >= 10 || shouldHide(child)) {
        output[key] = '?'
      } else if (shouldSimplify(child)) {
        output[key] = child
      } else {
        queue.push({
          input: child,
          output: output[key] = {},
          depth: nextDepth
        })
      }
    }
  }

  return output
}

function isObject (val) {
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

function isBSON (val) {
  return val && val._bsontype && val._bsontype === 'Binary'
}

module.exports = MongodbCorePlugin
