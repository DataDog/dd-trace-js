'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MongodbCorePlugin extends DatabasePlugin {
  static name = 'mongodb-core'
  static component = 'mongodb'

  start ({ ns, ops, options = {}, name }) {
    const query = getQuery(ops)
    const resource = truncate(getResource(ns, query, name))

    this.startSpan('mongodb.query', {
      service: this.config.service,
      resource,
      type: 'mongodb',
      kind: 'client',
      meta: {
        'db.name': ns,
        'mongodb.query': query,
        'out.host': options.host,
        'out.port': options.port
      }
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
  return Buffer.isBuffer(input) || typeof input === 'function' || isBinary(input)
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
  return val && val._bsontype && !isBinary(val)
}

function isBinary (val) {
  return val && val._bsontype === 'Binary'
}

module.exports = MongodbCorePlugin
