'use strict'

const { isMap, isRegExp } = require('node:util').types

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

  constructor (...args) {
    super(...args)

    // bulkWrite is higher-level than the wire commands `query` traces, so it has its own channel.
    this.addBind('apm:mongodb:bulkwrite:start', ctx => this.bindBulkWriteStart(ctx))
    this.addSub('apm:mongodb:bulkwrite:finish', ctx => this.finish(ctx))
    // Restore the parent store before the legacy callback runs, so a span started there nests
    // under the original parent instead of the already-finished bulkWrite span.
    this.addBind('apm:mongodb:bulkwrite:finish', ctx => ctx.parentStore)
    this.addSub('apm:mongodb:bulkwrite:error', ctx => this.error(ctx))
  }

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
   * Open the parent span for a `Collection#bulkWrite`. The per-type wire commands nest as
   * children and carry the statements, host, and DBM comment, so this span only records
   * the namespace and resource.
   *
   * @param {{ ns: string }} ctx
   */
  bindBulkWriteStart (ctx) {
    const { ns } = ctx
    const serviceResult = this.serviceName({ pluginConfig: this.config })

    this.startSpan(this.operationName(), {
      service: serviceResult,
      resource: truncate(`bulkWrite ${ns}`),
      type: 'mongodb',
      kind: 'client',
      meta: {
        'db.name': ns,
      },
    }, ctx)

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
  if (input === null ||
      typeof input !== 'object' ||
      ArrayBuffer.isView(input) ||
      input._bsontype !== undefined ||
      isRegExp(input) ||
      isMap(input) ||
      typeof input.toJSON === 'function') {
    return false
  }
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
        ArrayBuffer.isView(child) ||
        child._bsontype !== undefined ||
        isRegExp(child) ||
        isMap(child) ||
        typeof child.toJSON === 'function') {
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
    return buildNone(input, [])
  }
  if (mode === 'redact') return buildRedact(input, [])
  return buildTypes(input, [])
}

const REDACT_LEAF = '"?"'

/**
 * @param {RegExp} value
 * @returns {string}
 */
function stringifyRegExp (value) {
  return `{"$regex":${JSON.stringify(value.source)},"$options":${JSON.stringify(value.flags)}}`
}

/**
 * @param {Record<string, unknown> | unknown[]} value
 * @param {object[]} ancestors
 * @returns {string | undefined}
 */
function buildNone (value, ancestors) {
  // ArrayBuffer views (Buffer, every TypedArray, DataView) and Binary BSON
  // wrappers redact at the leaf; the walker neither recurses into the bytes
  // nor invokes any custom conversion.
  const bsontype = value._bsontype
  if (ArrayBuffer.isView(value) || bsontype === 'Binary' ||
      ancestors.length >= MAX_DEPTH || ancestors.includes(value)) {
    return REDACT_LEAF
  }

  if (isRegExp(value)) return stringifyRegExp(value)

  // Mirror JSON.stringify's contract: when `toJSON` is present, walk its
  // result (wrappers like Timestamp / Decimal128 expand to a small object,
  // ObjectId / Date flatten to a primitive).
  if (typeof value.toJSON === 'function') {
    const json = value.toJSON()
    if (json === value) return REDACT_LEAF
    // JSON.stringify keeps a null result as null (an invalid Date's toJSON
    // returns null); only function / symbol / undefined results drop the key.
    if (json === null) return 'null'
    if (typeof json !== 'object') return classifyLeafForNone(json)
    // A wrapper that exposes binary state through toJSON (Buffer-backed
    // class with WeakMap state, etc.) returns a TypedArray here. Re-screen
    // before the per-key walk would expand it element by element.
    if (ArrayBuffer.isView(json) || json._bsontype === 'Binary') return REDACT_LEAF
    value = json
  } else if (bsontype !== undefined) {
    return REDACT_LEAF
  }

  // The driver serializes a Map via its entries; mirror that as a document so
  // the tag matches the wire shape.
  if (isMap(value)) value = Object.fromEntries(value)

  ancestors.push(value)

  let result
  if (Array.isArray(value)) {
    result = '['
    let sep = ''
    for (let i = 0; i < value.length; i++) {
      // JSON.stringify renders unsupported leaves (function, symbol, undefined) as null in arrays.
      result += sep + (classifyForNone(value[i], ancestors) ?? 'null')
      sep = ','
    }
    result += ']'
  } else {
    result = '{'
    let sep = ''
    for (const key of Object.keys(value)) {
      const childResult = classifyForNone(value[key], ancestors)
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
 * @returns {string | undefined}
 */
function classifyForNone (child, ancestors) {
  if (typeof child !== 'object') return classifyLeafForNone(child)
  if (child === null) return 'null'
  return buildNone(child, ancestors)
}

/**
 * @param {unknown} leaf
 * @returns {string | undefined}
 */
function classifyLeafForNone (leaf) {
  // Implicit `undefined` for function / symbol / undefined matches the
  // contract callers rely on: JSON.stringify drops those property values
  // inside objects and writes `null` in arrays.
  switch (typeof leaf) {
    case 'string': return JSON.stringify(leaf)
    case 'number': return Number.isFinite(leaf) ? String(leaf) : 'null'
    case 'boolean': return leaf ? 'true' : 'false'
    case 'bigint': return `"${String(leaf)}"`
  }
}

/**
 * @param {Record<string, unknown> | unknown[]} value
 * @param {object[]} ancestors
 */
function buildRedact (value, ancestors) {
  const bsontype = value._bsontype
  if (ArrayBuffer.isView(value) || bsontype === 'Binary' || isRegExp(value) ||
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
    // Re-screen: toJSON can return a TypedArray or Binary BSON wrapper.
    if (ArrayBuffer.isView(json) || json._bsontype === 'Binary') return REDACT_LEAF
    value = json
  } else if (bsontype !== undefined) {
    return REDACT_LEAF
  }

  if (isMap(value)) value = Object.fromEntries(value)

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
  if (ArrayBuffer.isView(value) || bsontype === 'Binary' || isRegExp(value) ||
      ancestors.length >= MAX_DEPTH || ancestors.includes(value)) {
    return TYPE_OBJECT
  }

  if (typeof value.toJSON === 'function') {
    const json = value.toJSON()
    if (typeof json !== 'object' ||
        json === null ||
        json === value ||
        ArrayBuffer.isView(json) ||
        json._bsontype === 'Binary') {
      return TYPE_OBJECT
    }
    value = json
  } else if (bsontype !== undefined) {
    return TYPE_OBJECT
  }

  if (isMap(value)) value = Object.fromEntries(value)

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
