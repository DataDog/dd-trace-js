'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class MongodbCorePlugin extends Plugin {
  static get name () {
    return 'mongodb-core'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:mongodb:query:start`, ({ ns, ops, options, name }) => {
      const query = getQuery(ops)

      this.startSpan('mongodb.query', {
        resource: getResource(ns, query, name),
        service: this.config.service || `${this.tracer.config.service}-mongodb`,
        kind: 'client',
        type: 'mongodb',
        meta: {
          'db.name': ns,
          'mongodb.query': query,
          'out.host': options.host,
          'out.port': options.port
        }
      })
    })

    this.addSub(`apm:mongodb:query:end`, () => {
      this.exit()
    })

    this.addSub(`apm:mongodb:query:error`, err => {
      this.addError(err)
    })

    this.addSub(`apm:mongodb:query:async-end`, () => {
      this.finishSpan()
    })
  }
}

function getQuery (cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return
  if (cmd.query) return JSON.stringify(sanitize(cmd.query))
  if (cmd.filter) return JSON.stringify(sanitize(cmd.filter))
}

function getResource (ns, query, operationName) {
  const parts = [operationName, ns]

  if (query) {
    parts.push(query)
  }

  return parts.join(' ')
}

function shouldHide (input) {
  return !isObject(input) || Buffer.isBuffer(input) || isBSON(input)
}

function sanitize (input) {
  if (shouldHide(input)) return '?'

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

      const child = input[key]
      if (depth >= 20 || shouldHide(child)) {
        output[key] = '?'
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
  return val && val._bsontype
}

module.exports = MongodbCorePlugin
