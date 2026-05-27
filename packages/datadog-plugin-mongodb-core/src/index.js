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

// Depth doubles as the cycle bound: a cycle pushes past MAX_DEPTH and bails,
// after which the slow path catches it via its ancestor stack.
/** @param {unknown} input */
function canStringifyDirect (input) {
  if (input === null || typeof input !== 'object') return false
  if (Buffer.isBuffer(input) || input._bsontype !== undefined) return false
  return canStringifyDirectWalk(input, 1)
}

/**
 * @param {Record<string, unknown> | unknown[]} value
 * @param {number} depth
 */
function canStringifyDirectWalk (value, depth) {
  if (depth > MAX_DEPTH) return false
  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) {
    if (child === null ||
        typeof child === 'string' ||
        typeof child === 'number' ||
        typeof child === 'boolean') {
      continue
    }
    if (typeof child !== 'object' ||
        Buffer.isBuffer(child) ||
        child._bsontype !== undefined) {
      return false
    }
    if (!canStringifyDirectWalk(child, depth + 1)) return false
  }
  return true
}

/**
 * @param {Record<string, unknown> | unknown[]} input
 * @param {'none' | 'types' | 'redact'} mode
 */
function sanitiseAndStringify (input, mode) {
  if (mode === 'none') {
    if (canStringifyDirect(input)) return JSON.stringify(input)
    return sanitiseNone(input)
  }
  if (mode === 'redact') return buildRedact(input, [])
  return buildTypes(input, [])
}

/** @param {Record<string, unknown> | unknown[]} input */
function sanitiseNone (input) {
  let ancestors
  return JSON.stringify(input, function (key, value) {
    if (typeof value !== 'object') {
      if (typeof value === 'function') return
      if (typeof value === 'bigint') return value.toString()
      // Binary's toJSON returns a base64 string before the replacer sees it,
      // so inspect this[key] for the original Binary to still redact it.
      if (this[key]?._bsontype === 'Binary') return '?'
      return value
    }
    if (value === null) return value

    if (key === '') {
      ancestors = [value]
      return value
    }

    // `this[key]` is a second read; a non-pure getter / Proxy can return
    // nullish here even when JSON.stringify snapshotted an object into `value`.
    const original = this[key]
    const bsontype = original?._bsontype
    if (Buffer.isBuffer(original) || bsontype === 'Binary' ||
        (bsontype !== undefined && value === original)) {
      return '?'
    }

    while (ancestors[ancestors.length - 1] !== this) {
      ancestors.pop()
    }
    if (ancestors.length >= MAX_DEPTH || ancestors.includes(value)) return '?'
    ancestors.push(value)
    return value
  })
}

const REDACT_LEAF = '"?"'

/**
 * @param {Record<string, unknown> | unknown[]} value
 * @param {object[]} ancestors
 */
function buildRedact (value, ancestors) {
  const bsontype = value._bsontype
  if (Buffer.isBuffer(value) || bsontype === 'Binary' ||
      ancestors.length >= MAX_DEPTH || ancestors.includes(value)) {
    return REDACT_LEAF
  }

  // Mirror JSON.stringify: when `toJSON` is present, walk its result (which
  // wrappers like Timestamp / Decimal128 expand to `{$timestamp: "..."}` etc).
  // A primitive, null, or self-reference collapses to the sentinel — master's
  // `value === original` short-circuit.
  if (typeof value.toJSON === 'function') {
    const json = value.toJSON()
    if (typeof json !== 'object' || json === null || json === value) return REDACT_LEAF
    value = json
  } else if (bsontype !== undefined) {
    return REDACT_LEAF
  }

  ancestors.push(value)

  let result
  if (Array.isArray(value)) {
    result = '['
    let sep = ''
    for (let i = 0; i < value.length; i++) {
      result += sep + classifyForRedact(value[i], ancestors)
      sep = ','
    }
    result += ']'
  } else {
    result = '{'
    let sep = ''
    for (const key of Object.keys(value)) {
      result += sep + JSON.stringify(key) + ':' + classifyForRedact(value[key], ancestors)
      sep = ','
    }
    result += '}'
  }
  ancestors.pop()
  return result
}

/**
 * @param {unknown} child
 * @param {object[]} ancestors
 */
function classifyForRedact (child, ancestors) {
  if (typeof child !== 'object' || child === null) return REDACT_LEAF
  return buildRedact(child, ancestors)
}

const TYPE_OBJECT = '"object"'
const TYPE_NULL = '"null"'
const TYPE_BY_TYPEOF = {
  string: '"string"',
  number: '"number"',
  boolean: '"boolean"',
  bigint: '"bigint"',
  undefined: '"undefined"',
}

/**
 * @param {Record<string, unknown> | unknown[]} value
 * @param {object[]} ancestors
 */
function buildTypes (value, ancestors) {
  const bsontype = value._bsontype
  if (Buffer.isBuffer(value) || bsontype === 'Binary' ||
      ancestors.length >= MAX_DEPTH || ancestors.includes(value)) {
    return TYPE_OBJECT
  }

  if (typeof value.toJSON === 'function') {
    const json = value.toJSON()
    if (typeof json !== 'object' || json === null || json === value) return TYPE_OBJECT
    value = json
  } else if (bsontype !== undefined) {
    return TYPE_OBJECT
  }

  ancestors.push(value)

  let result
  if (Array.isArray(value)) {
    result = '['
    let sep = ''
    for (let i = 0; i < value.length; i++) {
      // JSON.stringify renders unsupported leaves (function, symbol) as null in arrays.
      result += sep + (classifyForTypes(value[i], ancestors) ?? 'null')
      sep = ','
    }
    result += ']'
  } else {
    result = '{'
    let sep = ''
    for (const key of Object.keys(value)) {
      const childResult = classifyForTypes(value[key], ancestors)
      if (childResult === undefined) continue
      result += sep + JSON.stringify(key) + ':' + childResult
      sep = ','
    }
    result += '}'
  }
  ancestors.pop()
  return result
}

/**
 * @param {unknown} child
 * @param {object[]} ancestors
 */
function classifyForTypes (child, ancestors) {
  if (typeof child !== 'object') return TYPE_BY_TYPEOF[typeof child]
  if (child === null) return TYPE_NULL
  return buildTypes(child, ancestors)
}

/** @param {unknown} value */
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
