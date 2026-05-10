'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MongodbCorePlugin extends DatabasePlugin {
  static id = 'mongodb-core'
  static component = 'mongodb'
  // avoid using db.name for peer.service since it includes the collection name
  // should be removed if one day this will be fixed
  /**
   * @override
   */
  static peerServicePrecursors = []

  /**
   * @override
   */
  configure (config) {
    super.configure(config)

    this.config.heartbeatEnabled = config.heartbeatEnabled ??
      this._tracerConfig.DD_TRACE_MONGODB_HEARTBEAT_ENABLED
    this.config.obfuscateQuery = config.obfuscateQuery ??
      this._tracerConfig.DD_TRACE_MONGODB_OBFUSCATE_QUERY ??
      false
  }

  bindStart (ctx) {
    const { ns, ops, options = {}, name } = ctx
    // heartbeat commands can be disabled if this.config.heartbeatEnabled is false
    if (!this.config.heartbeatEnabled && isHeartbeat(ops, this.config)) {
      return
    }
    const query = getQuery(ops, this.config.obfuscateQuery)
    const resource = truncate(getResource(this, ns, query, name))
    const serviceResult = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service: serviceResult,
      resource,
      type: 'mongodb',
      kind: 'client',
      meta: {
        // this is not technically correct since it includes the collection but we changing will break customer stuff
        'db.name': ns,
        'mongodb.query': query,
        'out.host': options.host,
        'out.port': options.port,
      },
    }, ctx)
    const comment = this.injectDbmComment(span, ops.comment, serviceResult.name)
    if (comment) {
      ops.comment = comment
    }

    return ctx.currentStore
  }

  /**
   * @override
   */
  getPeerService (tags) {
    let ns = tags['db.name']
    if (ns && tags['peer.service'] === undefined) {
      const dotIndex = ns.indexOf('.')
      if (dotIndex !== -1) {
        ns = ns.slice(0, dotIndex)
      }
      // the mongo ns is either dbName either dbName.collection. So we keep the first part
      tags['peer.service'] = ns
    }
    return super.getPeerService(tags)
  }

  injectDbmComment (span, comment, serviceName) {
    const dbmTraceComment = this.createDbmComment(span, serviceName)

    if (!dbmTraceComment) {
      return comment
    }

    if (comment) {
      // if the command already has a comment, append the dbm trace comment
      if (typeof comment === 'string') {
        comment += `,${dbmTraceComment}`
      } else if (Array.isArray(comment)) {
        comment.push(dbmTraceComment)
      } // do nothing if the comment is not a string or an array
    } else {
      comment = dbmTraceComment
    }

    return comment
  }
}

const MAX_DEPTH = 10
const MAX_QUERY_LENGTH = 10_000

function extractQuery (statements) {
  if (statements.length === 1 && statements[0].q) return statements[0].q

  const extractedQueries = []
  for (let i = 0; i < statements.length; i++) {
    if (statements[i].q) {
      extractedQueries.push(statements[i].q)
    }
  }

  return extractedQueries
}

/**
 * @param {Record<string, unknown> | unknown[] | undefined} cmd
 * @param {boolean} obfuscate
 */
function getQuery (cmd, obfuscate) {
  if (!cmd || (typeof cmd !== 'object' && !Array.isArray(cmd))) return

  if (Array.isArray(cmd)) return sanitiseAndStringify(extractQuery(cmd), obfuscate)
  if (cmd.query) return sanitiseAndStringify(cmd.query, obfuscate)
  if (cmd.filter) return sanitiseAndStringify(cmd.filter, obfuscate)
  if (cmd.pipeline) return sanitiseAndStringify(cmd.pipeline, obfuscate)
  if (cmd.deletes) return sanitiseAndStringify(extractQuery(cmd.deletes), obfuscate)
  if (cmd.updates) return sanitiseAndStringify(extractQuery(cmd.updates), obfuscate)
}

function getResource (plugin, ns, query, operationName) {
  let resource = `${operationName} ${ns}`

  if (plugin.config.queryInResourceName && query) {
    resource += ` ${query}`
  }

  return resource
}

function truncate (input) {
  return input.length > MAX_QUERY_LENGTH ? input.slice(0, MAX_QUERY_LENGTH) : input
}

// Single-pass sanitisation. The replacer:
// - skips functions and coerces bigint to its decimal string,
// - returns '?' for Buffer / BSON Binary on the *original* value (JSON.stringify already invoked
//   toJSON before calling us; Buffer / Binary do have toJSON outputs we want to suppress),
// - lets JSON.stringify call toJSON on other BSON types (ObjectId, Long, Decimal128, Date, Timestamp, ...)
//   so the result lands here as a primitive or plain object,
// - returns '?' for BSON types without toJSON (MinKey, MaxKey) where `value === original`,
// - tracks depth via an ancestor stack so cycles and depth >= MAX_DEPTH collapse to '?',
// - when `obfuscate` is true, replaces every primitive leaf (including null) with '?' while
//   preserving keys and structure so the resulting JSON is still a usable query signature.
/**
 * @param {Record<string, unknown> | unknown[]} input
 * @param {boolean} obfuscate
 */
function sanitiseAndStringify (input, obfuscate) {
  const ancestors = []
  return JSON.stringify(input, function (key, value) {
    if (typeof value === 'function') return
    if (typeof value === 'bigint') return obfuscate ? '?' : value.toString()

    const original = key === '' ? value : this[key]
    if (typeof original === 'object' && original !== null) {
      if (Buffer.isBuffer(original)) return '?'
      const bsontype = original._bsontype
      if (bsontype !== undefined && (bsontype === 'Binary' || value === original)) {
        return '?'
      }
    }

    if (value === null || typeof value !== 'object') return obfuscate && key !== '' ? '?' : value

    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
    if (ancestors.length >= MAX_DEPTH || ancestors.includes(value)) return '?'
    ancestors.push(value)

    return value
  })
}

function isHeartbeat (ops, config) {
  // Check if it's a heartbeat command https://github.com/mongodb/specifications/blob/master/source/mongodb-handshake/handshake.md
  return (
    ops &&
    typeof ops === 'object' &&
    (ops.hello === 1 || ops.helloOk === true || ops.ismaster === 1 || ops.isMaster === 1)
  )
}

module.exports = MongodbCorePlugin
