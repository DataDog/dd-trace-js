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
    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
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
    ops = this.injectDbmCommand(span, ops, service)
  }

  getPeerService (tags) {
    const ns = tags['db.name']
    if (ns && tags['peer.service'] === undefined) {
      // the mongo ns is either dbName either dbName.collection. So we keep the first part
      tags['peer.service'] = ns.split('.', 1)[0]
    }
    return super.getPeerService(tags)
  }

  injectDbmCommand (span, command, serviceName) {
    const dbmTraceComment = this.createDbmComment(span, serviceName)

    if (!dbmTraceComment) {
      return command
    }

    // create a copy of the command to avoid mutating the original
    const dbmTracedCommand = { ...command }

    if (dbmTracedCommand.comment) {
      // if the command already has a comment, append the dbm trace comment
      if (typeof dbmTracedCommand.comment === 'string') {
        dbmTracedCommand.comment += `,${dbmTraceComment}`
      } else if (Array.isArray(dbmTracedCommand.comment)) {
        dbmTracedCommand.comment.push(dbmTraceComment)
      } // do nothing if the comment is not a string or an array
    } else {
      dbmTracedCommand.comment = dbmTraceComment
    }

    return dbmTracedCommand
  }
}

function sanitizeBigInt (data) {
  return JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
}

function getQuery (cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return
  if (cmd.query) return sanitizeBigInt(limitDepth(cmd.query))
  if (cmd.filter) return sanitizeBigInt(limitDepth(cmd.filter))
  if (cmd.pipeline) return sanitizeBigInt(limitDepth(cmd.pipeline))
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
  return !isObject(input) || typeof input.toJSON === 'function'
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
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

function isBSON (val) {
  return val && val._bsontype && !isBinary(val)
}

function isBinary (val) {
  return val && val._bsontype === 'Binary'
}

module.exports = MongodbCorePlugin
