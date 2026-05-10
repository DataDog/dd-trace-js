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
    this.config.obfuscateQuery = normaliseObfuscateQuery(
      config.obfuscateQuery ?? this._tracerConfig.DD_TRACE_MONGODB_OBFUSCATE_QUERY
    )
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
 * @param {'none' | 'types' | 'redact'} mode
 */
function getQuery (cmd, mode) {
  if (!cmd || (typeof cmd !== 'object' && !Array.isArray(cmd))) return

  if (Array.isArray(cmd)) return sanitiseAndStringify(extractQuery(cmd), mode)
  if (cmd.query) return sanitiseAndStringify(cmd.query, mode)
  if (cmd.filter) return sanitiseAndStringify(cmd.filter, mode)
  if (cmd.pipeline) return sanitiseAndStringify(cmd.pipeline, mode)
  if (cmd.deletes) return sanitiseAndStringify(extractQuery(cmd.deletes), mode)
  if (cmd.updates) return sanitiseAndStringify(extractQuery(cmd.updates), mode)
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
// - collapses Buffer / BSON Binary / BSON types without toJSON (MinKey, MaxKey) to a sentinel,
// - lets JSON.stringify call toJSON on other BSON types (ObjectId, Long, Decimal128, Date, Timestamp, ...)
//   so the result lands here as a primitive or plain object,
// - tracks depth via an ancestor stack so cycles and depth >= MAX_DEPTH collapse to the sentinel,
// - in `redact` mode, replaces every primitive leaf (including null) with '?',
// - in `types` mode, replaces every primitive leaf with the typeof of the *original* value (so a
//   BSON Date that flattens to a string still reports as 'object'), and 'null' for null.
// Keys, operator names, and array / pipeline shape are preserved in both modes so the resulting
// JSON is still a usable query signature.
/**
 * @param {Record<string, unknown> | unknown[]} input
 * @param {'none' | 'types' | 'redact'} mode
 */
function sanitiseAndStringify (input, mode) {
  const ancestors = []
  return JSON.stringify(input, function (key, value) {
    if (typeof value === 'function') return
    if (typeof value === 'bigint') {
      if (mode === 'redact') return '?'
      if (mode === 'types') return 'bigint'
      return value.toString()
    }

    const original = key === '' ? value : this[key]
    if (typeof original === 'object' && original !== null) {
      const bsontype = original._bsontype
      if (Buffer.isBuffer(original) || (bsontype !== undefined && (bsontype === 'Binary' || value === original))) {
        return mode === 'types' ? 'object' : '?'
      }
    }

    if (value === null || typeof value !== 'object') {
      if (key === '' || mode === 'none') return value
      if (mode === 'redact') return '?'
      return original === null ? 'null' : typeof original
    }

    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
    if (ancestors.length >= MAX_DEPTH || ancestors.includes(value)) {
      return mode === 'types' ? 'object' : '?'
    }
    ancestors.push(value)

    return value
  })
}

/**
 * Coerce the plugin-config and env values for `obfuscateQuery` to one of the three canonical modes.
 * Anything outside the enum — including `undefined` — falls back to `'none'`.
 *
 * @param {unknown} value
 * @returns {'none' | 'types' | 'redact'}
 */
function normaliseObfuscateQuery (value) {
  if (value === 'types' || value === 'redact') return value
  return 'none'
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
