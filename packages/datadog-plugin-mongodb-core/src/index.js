'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MongodbCorePlugin extends DatabasePlugin {
  static get id () { return 'mongodb-core' }
  static get component () { return 'mongodb' }
  // avoid using db.name for peer.service since it includes the collection name
  // should be removed if one day this will be fixed
  static get peerServicePrecursors () { return [] }
  start ({ ns, ops, options = {}, name }) {
    const query = getQuery(ops)
    const resource = truncate(getResource(this, ns, query, name))

    const span = this.startSpan(this.operationName(), {
      service: this.serviceName(this.config),
      resource,
      type: 'mongodb',
      kind: 'client',
      meta: {
        // this is not technically correct since it includes the collection but we changing will break customer stuff
        'db.name': ns,
        'mongodb.query': query,
        'out.host': options.host,
        'out.port': options.port
      }
    })
    if (this.tracer._computePeerService && ns) {
      const dbParts = ns.split('.', 2)
      // if we should compute peer.service and the ns is well formed (dbName.collection)
      // then we can eagerly set if safely
      if (dbParts.length === 2) {
        span.setTag('peer.service', dbParts[0])
      }
    }
  }
}

function getQuery (cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return
  if (cmd.query) return JSON.stringify(limitDepth(cmd.query))
  if (cmd.filter) return JSON.stringify(limitDepth(cmd.filter))
}

function getResource (plugin, ns, query, operationName) {
  const parts = [operationName, ns]

  if (plugin.config.queryInResourceName && query) {
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
        child = typeof child.toJSON === 'function' ? child.toJSON() : '?'
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
