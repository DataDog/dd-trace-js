'use strict'

const { randomUUID } = require('node:crypto')
const { types } = require('node:util')

const { channel } = require('dc-polyfill')

const log = require('../../log')
const { MCP_SERVERS, activeTrace, consumeMark, createClientServer, recordListedTools } = require('../mcp')
const { SOURCE_AUTO } = require('../tags')

const callToolInterceptChannel = channel('dd-trace:mcp:callTool:intercept')
const listToolsResultChannel = channel('dd-trace:mcp:listTools:result')

// These transports send the JSON form of the params, so the server gets exactly that form.
const JSON_TRANSPORTS = new Set(['stdio', 'sse', 'streamable_http', 'websocket'])
const CYCLE = '[Circular]'
const UNREADABLE = '[Unreadable]'
const TRUNCATED = '[Truncated]'
// The JSON text that the check gets has at most this many entries. The cap bounds the evaluation,
// not the call: model output is far smaller, and only a large value of the application goes past it.
// The copy that the server gets is not capped, and for a truncated text, hasUnsafeObject scans the
// rest of the clone. That work grows with the size of the arguments, like the clone itself.
const MAX_JSON_ENTRIES = 1_000_000
// The structured clone of the arguments cannot be the value that the server gets.
const NO_CLONE = Symbol('dd-trace.aiguard.noClone')
// The operations of the stack of safeJson. Each task has two slots: the operation and its value.
const WRITE_TEXT = 1
const WRITE_VALUE = 2
const LEAVE = 3

/** @typedef {import('../mcp').McpServer} McpServer */
/** @typedef {import('../mcp').TransportInfo} TransportInfo */

/**
 * @typedef {object} CallToolContext
 * @property {object} client
 * @property {unknown} transport
 * @property {TransportInfo|undefined} transportInfo
 * @property {IArguments} arguments The call arguments. The SDK gets them when the call starts.
 * @property {() => Promise<unknown>|undefined} [beforeCall]
 */

/**
 * @typedef {object} PreparedCall
 * @property {unknown} [name] The tool name to evaluate. Without it, no evaluation runs.
 * @property {string} [args] The JSON arguments to evaluate. Without them, the evaluation gets {}.
 * @property {object} params The params that the SDK sends instead of the params of the application.
 */

/**
 * @typedef {object} Budget
 * @property {number} entries The number of entries that the text can still have.
 * @property {boolean} truncated Whether the text left out entries.
 */

/**
 * @typedef {object} SafeJsonState
 * @property {number} entries The number of entries that the text can still have.
 * @property {string[]} parts
 * @property {unknown[]} stack
 * @property {Set<object>} ancestors
 */

/** @type {WeakMap<object, McpServer|undefined>} */
const serversByTransport = new WeakMap()

let isEnabled = false
let aiguard
let opts

/**
 * Subscribes AI Guard to the MCP client channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 */
function enable (aiguardInstance, block) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'mcp' }

  callToolInterceptChannel.subscribe(onCallTool)
  listToolsResultChannel.subscribe(onListToolsResult)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  callToolInterceptChannel.unsubscribe(onCallTool)
  listToolsResultChannel.unsubscribe(onListToolsResult)

  aiguard = undefined
  opts = undefined
  isEnabled = false
}

/**
 * Returns the server of a client transport. The entry stays the same for the life of the
 * transport.
 *
 * @param {unknown} transport
 * @param {TransportInfo|undefined} info
 * @returns {McpServer|undefined}
 */
function resolveServer (transport, info) {
  if (transport === null || typeof transport !== 'object') return createClientServer(info)
  if (serversByTransport.has(transport)) return serversByTransport.get(transport)

  const server = createClientServer(info)
  serversByTransport.set(transport, server)
  return server
}

/**
 * @param {{ client: object, transport: unknown, transportInfo: TransportInfo|undefined, tools: unknown }} ctx
 */
function onListToolsResult (ctx) {
  try {
    recordListedTools(ctx.transport, resolveServer(ctx.transport, ctx.transportInfo), ctx.tools)
  } catch (error) {
    log.debug('AIGuard: unable to record the listed MCP tools: %s', error?.message)
  }
}

/**
 * @param {CallToolContext} ctx
 */
function onCallTool (ctx) {
  ctx.beforeCall = () => checkToolCall(ctx)
}

/**
 * Checks a tool call before the client sends it. Only a block rejects. Any other failure lets the
 * call run.
 *
 * @param {CallToolContext} ctx
 * @returns {Promise<void>|undefined} undefined when the call needs no evaluation.
 */
function checkToolCall (ctx) {
  let evaluation
  try {
    evaluation = evaluateToolCall(ctx)
  } catch (error) {
    log.debug('AIGuard: unable to evaluate the MCP tool call: %s', error?.message)
    return
  }
  return evaluation?.then(ignoreResult, onEvaluationError)
}

function ignoreResult () {}

/**
 * @param {Error} error
 */
function onEvaluationError (error) {
  if (error?.name === 'AIGuardAbortError') throw error
  log.debug('AIGuard: unexpected error during MCP tool call evaluation: %s', error?.message)
}

/**
 * Evaluates the tool call as one assistant message. A call that a model response evaluation
 * already checked on the same connection and in the same trace gets no second evaluation.
 *
 * @param {CallToolContext} ctx
 * @returns {Promise<unknown>|undefined}
 */
function evaluateToolCall (ctx) {
  const params = ctx.arguments[0]
  if (params === null || typeof params !== 'object') return

  const call = JSON_TRANSPORTS.has(/** @type {string} */ (ctx.transportInfo?.type))
    ? prepareJsonCall(params)
    : prepareCall(params, ctx.transportInfo)

  // The SDK sends the copy, also for a call that starts at once. Then a change to the params of
  // the application after callTool returns cannot reach the server.
  ctx.arguments[0] = call.params

  // Without a tool name, the request selects no tool, so no tool can run.
  if (call.name === undefined) return
  const name = typeof call.name === 'string' ? call.name : String(call.name)
  const args = call.args ?? '{}'

  if (consumeMark(activeTrace(), ctx.transport, name, args)) return

  // No model call ID exists for a direct call, so the call gets a local ID.
  /** @type {{ id: string, function: { name: string, arguments: string }, mcp?: { server_id: string } }} */
  const toolCall = { id: `dd_mcp_${randomUUID().replaceAll('-', '')}`, function: { name, arguments: args } }
  const messages = [{ role: 'assistant', tool_calls: [toolCall] }]
  const server = resolveServer(ctx.transport, ctx.transportInfo)
  // A server that no key identifies gets the evaluation of an ordinary tool call.
  if (!server) return aiguard.evaluate(messages, opts)

  toolCall.mcp = { server_id: server.id }
  return aiguard.evaluate(messages, { ...opts, [MCP_SERVERS]: [{ ...server, tools: { [name]: name } }] })
}

/**
 * Returns the tool name and the arguments to evaluate for a transport that sends the JSON form of
 * the params, and the copy of the params that the SDK sends.
 *
 * The check makes the JSON form of the params once, as the SDK does. A toJSON method of the params,
 * of the name or of the arguments applies there. The evaluation reads the name and the arguments of
 * that form, and the copy is that form. Thus the server gets only the name and the arguments that the
 * evaluation read.
 *
 * @param {object} params
 * @returns {PreparedCall}
 */
function prepareJsonCall (params) {
  /** @type {unknown} */
  let wire
  let args
  try {
    // The SDK writes the params as the params key of the request, so toJSON gets the key params.
    const text = JSON.stringify({ params })
    wire = JSON.parse(text).params
    const callArguments = /** @type {{ arguments?: unknown }|undefined} */ (wire)?.arguments
    if (callArguments !== undefined) args = JSON.stringify(callArguments)
  } catch (error) {
    return prepareFailedJsonCall(params, error)
  }

  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
    // The JSON form has no tool name. JSON.stringify calls toJSON only once, so the copy gives the
    // same value and the SDK does not call the toJSON method of the application again.
    return { params: { toJSON: () => wire } }
  }
  const { name } = /** @type {{ name?: unknown }} */ (wire)
  return { name, args, params: wire }
}

/**
 * Returns the call of a JSON transport whose params JSON cannot write. The SDK gets a copy whose
 * serialization throws the same error, so the server gets nothing. The evaluation reads the name
 * and the arguments of the params again, and never throws.
 *
 * @param {{ name?: unknown, arguments?: unknown }} params
 * @param {unknown} error
 * @returns {PreparedCall}
 */
function prepareFailedJsonCall (params, error) {
  // A spread of the copy keeps its toJSON method, so the SDK cannot send it.
  /** @type {Record<string, unknown>} */
  const copy = failingJson(error)
  try {
    const name = params.name
    if (name === undefined) return { params: copy }

    const args = safeJson(params.arguments)
    // The SDK reads the name and the arguments before it sends the request.
    copy.name = name
    if (args !== undefined) copy.arguments = JSON.parse(args)
    return { name, args, params: copy }
  } catch {
    // A read of the params throws. The evaluation gets no tool name.
    return { params: copy }
  }
}

/**
 * Returns the tool name and the arguments to evaluate for a transport that can give the server the
 * objects themselves, and the copy of the params that the SDK sends. The copy is a structured clone
 * that keeps the data and its types, and the evaluation gets the content of the clone.
 *
 * @param {{ name?: unknown, arguments?: unknown }} params
 * @param {TransportInfo|undefined} info
 * @returns {PreparedCall}
 */
function prepareCall (params, info) {
  // The check and the copy use one read of each value of the application.
  const toolName = params.name
  if (toolName === undefined) return { params }

  // An in-process server rejects a name that is not a string. A custom transport can send the JSON
  // form of an object, for example the value of its toJSON method. For such a transport, the copy
  // gets the name that the evaluation reads.
  const name = info?.type !== 'in_process' && toolName !== null &&
    (typeof toolName === 'object' || typeof toolName === 'function')
    ? readableString(toolName)
    : toolName
  const checked = checkArguments(params.arguments)
  return { name, args: checked.text, params: copyParams(params, name, checked.value) }
}

/**
 * @param {object} value
 */
function readableString (value) {
  try {
    return String(value)
  } catch {
    return UNREADABLE
  }
}

/**
 * Returns a value whose JSON serialization throws error.
 *
 * @param {unknown} error
 * @returns {{ toJSON: () => never }}
 */
function failingJson (error) {
  return {
    toJSON () {
      throw error
    },
  }
}

/**
 * Returns a copy of the params with the tool name and the arguments that the check read. It reads
 * each other value of the params once and keeps the order of the keys. The SDK always gets the copy,
 * so the params of the application never reach the server after the check.
 *
 * A value whose read throws becomes a value that throws the same error when it is read. Without the
 * check, that read is the first one, of the SDK or of an in-process server, and it fails the same
 * way. When the keys cannot be listed, the serialization of the copy throws the error.
 *
 * The copy has no toJSON key of the params. An in-process server reads the name and the arguments,
 * not the JSON form. A custom transport can send the JSON form, and then a toJSON method of the
 * params could send a name and arguments that the evaluation did not read.
 *
 * @param {object} params
 * @param {unknown} toolName
 * @param {unknown} [args] The arguments to send. Without them, the copy has no arguments.
 * @returns {object}
 */
function copyParams (params, toolName, args) {
  // Only the name and the arguments are snapshots. The check does not read the other keys, for
  // example _meta, so they stay shallow copies.
  const source = /** @type {Record<string, unknown>} */ (params)
  /** @type {Record<string, unknown>} */
  const copy = {}
  let keys
  try {
    keys = Object.keys(source)
  } catch (error) {
    keys = []
    copy.toJSON = failingJson(error).toJSON
  }
  for (const key of keys) {
    if (key === 'name') {
      copy.name = toolName
    } else if (key === 'arguments') {
      if (args !== undefined) copy.arguments = args
    } else if (key !== 'toJSON') {
      copyValue(copy, source, key)
    }
  }
  // The params can inherit the name or the arguments.
  copy.name = toolName
  if (args !== undefined) copy.arguments = args
  return copy
}

/**
 * Copies one value of the params. A value whose read throws becomes a getter that throws the error.
 *
 * @param {Record<string, unknown>} copy
 * @param {Record<string, unknown>} source
 * @param {string} key
 */
function copyValue (copy, source, key) {
  let value
  try {
    value = source[key]
  } catch (error) {
    Object.defineProperty(copy, key, {
      get () {
        throw error
      },
      enumerable: true,
      configurable: true,
    })
    return
  }
  setValue(copy, key, value)
}

/**
 * Sets an own value. A __proto__ key stays an own key, as JSON.parse makes it.
 *
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
function setValue (target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    target[key] = value
  }
}

/**
 * Returns the arguments that a transport without JSON gives the server, and their JSON text for the
 * check. A structured clone keeps the types of the data, and a change of the application cannot
 * reach it. Without a clone, the server gets the JSON form of the arguments, as on the wire.
 *
 * @param {unknown} callArguments
 * @returns {{ text: string|undefined, value: unknown }}
 */
function checkArguments (callArguments) {
  /** @type {unknown} */
  let clone = NO_CLONE
  try {
    clone = structuredClone(callArguments)
  } catch {
    // A proxy, a function, a symbol, a toJSON method or a very deep value has no structured clone.
  }
  const text = clone === NO_CLONE ? NO_CLONE : cloneJson(clone)
  if (text !== NO_CLONE) return { text, value: clone }

  // This second read of the arguments can run a getter again after a failed clone. The server gets
  // the text, so a huge value without a clone arrives truncated, which is very rare.
  const json = safeJson(callArguments)
  return { text: json, value: json === undefined ? undefined : JSON.parse(json) }
}

/**
 * Returns the JSON text of a structured clone for the check. A Map, a Set, a RegExp, an Error and
 * binary values get their content, a BigInt gets its decimal string, and a cycle gets a placeholder.
 * The text has at most MAX_JSON_ENTRIES entries, but the server gets the full clone.
 *
 * @param {unknown} clone
 * @returns {string|undefined|typeof NO_CLONE} NO_CLONE when the clone cannot be the sent value: a
 *   SharedArrayBuffer shares its memory with the application, the check cannot see the content of
 *   other objects, for example a Blob, and JSON.stringify cannot write a value that is too deep.
 */
function cloneJson (clone) {
  /** @type {Budget} */
  const budget = { entries: MAX_JSON_ENTRIES, truncated: false }
  let fallback = false
  // The objects that JSON.stringify writes now, each with the clone value that it comes from.
  /** @type {Array<[object, object]>} */
  const holders = []
  /** @type {Set<object>} */
  const ancestors = new Set()

  /**
   * JSON.stringify calls the replacer with the object that holds the value as this.
   *
   * @this {object}
   * @param {string} key
   * @param {unknown} value
   */
  function replacer (key, value) {
    if (fallback) return
    // The objects above the holder are complete.
    while (holders.length > 0 && holders.at(-1)?.[0] !== this) {
      ancestors.delete(/** @type {[object, object]} */ (holders.pop())[1])
    }
    // JSON.stringify calls toJSON before the replacer, so the check reads the raw value too.
    const raw = /** @type {Record<string, unknown>} */ (this)[key]
    if (raw !== null && typeof raw === 'object' && !isKnownObject(raw)) {
      fallback = true
      return
    }
    if (typeof value === 'bigint') return value.toString()
    if (value === null || typeof value !== 'object') return value
    if (ancestors.has(value)) return CYCLE

    const content = cloneContent(value, budget)
    if (content === NO_CLONE) {
      fallback = true
      return
    }
    if (content !== null && typeof content === 'object') {
      holders.push([content, value])
      ancestors.add(value)
    }
    return content
  }

  let text
  try {
    text = JSON.stringify(clone, replacer)
  } catch {
    // The clone is too deep.
    return NO_CLONE
  }
  // The replacer sees no value past the budget, so a scan looks for these objects there.
  if (fallback || (budget.truncated && hasUnsafeObject(clone))) return NO_CLONE
  return text
}

/**
 * Returns whether the check writes the content of an object of a structured clone. Other objects,
 * for example a Blob or a BlockList, belong to the platform: the check cannot see their content, and
 * the clone of some of them shares a native handle with the application.
 *
 * @param {object} value
 */
function isKnownObject (value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null || prototype === Array.prototype ||
    types.isDate(value) || types.isMap(value) || types.isSet(value) || types.isRegExp(value) ||
    ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value) || types.isNativeError(value) ||
    types.isBoxedPrimitive(value)
}

/**
 * Returns whether a structured clone contains an object that the server cannot get as a clone: a
 * SharedArrayBuffer, also as the buffer of a view, or an object of the platform. The clone is plain
 * data, so the scan has no side effects. Own keys keep the scan of a sparse array cheap.
 *
 * @param {unknown} clone
 */
function hasUnsafeObject (clone) {
  const stack = [clone]
  /** @type {Set<object>} */
  const seen = new Set()
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (types.isSharedArrayBuffer(value) || !isKnownObject(value)) return true
    if (ArrayBuffer.isView(value)) {
      if (types.isSharedArrayBuffer(value.buffer)) return true
    } else if (types.isMap(value)) {
      for (const entry of /** @type {Map<unknown, unknown>} */ (value)) stack.push(entry[0], entry[1])
    } else if (types.isSet(value)) {
      for (const item of /** @type {Set<unknown>} */ (value)) stack.push(item)
    } else {
      const object = /** @type {Record<string, unknown>} */ (value)
      for (const key of Object.keys(object)) stack.push(object[key])
      if (types.isNativeError(value)) stack.push(/** @type {Error} */ (value).cause)
    }
  }
  return false
}

/**
 * Returns what the check writes for an object of a structured clone. As in safeJson, an object or a
 * list counts its entries when the check starts it, and the entries past the budget become one
 * placeholder.
 *
 * @param {object} value An object that isKnownObject accepts.
 * @param {Budget} budget
 * @returns {unknown} NO_CLONE for a SharedArrayBuffer, which shares its memory with the application.
 */
function cloneContent (value, budget) {
  if (types.isSharedArrayBuffer(value)) return NO_CLONE
  if (ArrayBuffer.isView(value)) {
    if (types.isSharedArrayBuffer(value.buffer)) return NO_CLONE
    const items = types.isDataView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : /** @type {ArrayLike<number|bigint>} */ (/** @type {unknown} */ (value))
    return takeItems(budget, items.length, index => {
      const item = items[index]
      return typeof item === 'bigint' ? item.toString() : item
    })
  }
  if (types.isArrayBuffer(value)) {
    const bytes = new Uint8Array(value)
    return takeItems(budget, bytes.length, index => bytes[index])
  }
  if (types.isMap(value) || types.isSet(value)) {
    const collection = /** @type {Map<unknown, unknown>|Set<unknown>} */ (value)
    const iterator = collection[Symbol.iterator]()
    return takeItems(budget, collection.size, () => iterator.next().value)
  }
  if (types.isRegExp(value)) return String(value)
  // JSON.stringify unwraps a Number, String or Boolean object, but not a BigInt object.
  if (types.isBoxedPrimitive(value)) {
    const primitive = value.valueOf()
    return typeof primitive === 'bigint' ? primitive.toString() : primitive
  }
  // The cause can contain other values, so the replacer gets it as a member too.
  const object = types.isNativeError(value)
    ? { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
    : value
  if (Array.isArray(object)) {
    if (object.length <= budget.entries) {
      budget.entries -= object.length
      return object
    }
    // A slice reads only the first entries, also of a sparse array with a huge length.
    const items = object.slice(0, budget.entries)
    items.push(TRUNCATED)
    budget.entries = 0
    budget.truncated = true
    return items
  }

  const keys = Object.keys(object)
  if (keys.length <= budget.entries) {
    budget.entries -= keys.length
    return object
  }
  /** @type {Record<string, unknown>} */
  const members = {}
  for (let i = 0; i < budget.entries; i++) {
    setValue(members, keys[i], /** @type {Record<string, unknown>} */ (object)[keys[i]])
  }
  members[TRUNCATED] = TRUNCATED
  budget.entries = 0
  budget.truncated = true
  return members
}

/**
 * Returns the first items of a list that the budget allows, and a placeholder for the rest.
 *
 * @param {Budget} budget
 * @param {number} length
 * @param {(index: number) => unknown} read
 * @returns {unknown[]}
 */
function takeItems (budget, length, read) {
  const count = Math.min(length, budget.entries)
  budget.entries -= count
  const items = []
  for (let i = 0; i < count; i++) items.push(read(i))
  if (count < length) {
    items.push(TRUNCATED)
    budget.truncated = true
  }
  return items
}

/**
 * Returns the JSON text of a value with the rules of JSON.stringify, but it never throws: a BigInt
 * gets its decimal string, a cycle or a value that throws gets a placeholder, and the entries past
 * MAX_JSON_ENTRIES get one placeholder. A stack replaces recursion, so a very deep value cannot
 * overflow the call stack.
 *
 * @param {unknown} value
 * @returns {string|undefined} undefined for a value that JSON leaves out, for example a function.
 */
function safeJson (value) {
  const root = toJsonValue(value, '')
  if (isLeftOut(root)) return
  /** @type {SafeJsonState} */
  const state = { entries: MAX_JSON_ENTRIES, parts: [], stack: [], ancestors: new Set() }
  writeSafeValue(state, root)
  const { parts, stack, ancestors } = state
  while (stack.length > 0) {
    const item = stack.pop()
    const operation = stack.pop()
    if (operation === WRITE_TEXT) {
      parts.push(/** @type {string} */ (item))
    } else if (operation === LEAVE) {
      ancestors.delete(/** @type {object} */ (item))
    } else {
      writeSafeValue(state, item)
    }
  }
  return parts.join('')
}

/**
 * Returns the value that JSON writes for a value: the result of its toJSON method, or the primitive
 * value of a Number, String, Boolean or BigInt object. A toJSON method that throws gives a placeholder.
 *
 * @param {unknown} value
 * @param {string} key The key of the value, for toJSON.
 * @returns {unknown}
 */
function toJsonValue (value, key) {
  if (typeof value === 'bigint' || typeof value === 'function' || (typeof value === 'object' && value !== null)) {
    try {
      const { toJSON } = /** @type {{ toJSON?: unknown }} */ (value)
      if (typeof toJSON === 'function') value = toJSON.call(value, key)
    } catch {
      return UNREADABLE
    }
  }
  // JSON writes a Symbol object as an empty object.
  if (typeof value === 'object' && value !== null && types.isBoxedPrimitive(value) && !types.isSymbolObject(value)) {
    return value.valueOf()
  }
  return value
}

/**
 * Writes one value that toJsonValue returned. For an object, it adds the tasks that write its entries.
 *
 * @param {SafeJsonState} state
 * @param {unknown} value
 */
function writeSafeValue (state, value) {
  const { parts, stack, ancestors } = state
  if (value === null || typeof value !== 'object') {
    // An object leaves out the values that JSON leaves out, so here such a value is an array item.
    parts.push(isLeftOut(value) ? 'null' : JSON.stringify(typeof value === 'bigint' ? value.toString() : value))
    return
  }
  if (ancestors.has(value)) {
    parts.push(JSON.stringify(CYCLE))
    return
  }

  const object = /** @type {Record<string, unknown>} */ (value)
  let keys
  let length
  try {
    keys = Array.isArray(object) ? undefined : Object.keys(object)
    const { length: items } = object
    length = keys ? keys.length : (typeof items === 'number' && items > 0 ? items : 0)
  } catch {
    // A proxy trap throws.
    parts.push(JSON.stringify(UNREADABLE))
    return
  }

  // Each entry has two slots: the key text, which is empty in an array, and the value.
  const count = Math.min(length, state.entries)
  state.entries -= count
  const entries = []
  for (let i = 0; i < count; i++) {
    const key = keys ? keys[i] : String(i)
    let item
    try {
      item = object[key]
    } catch {
      item = UNREADABLE
    }
    item = toJsonValue(item, key)
    if (!keys || !isLeftOut(item)) entries.push(keys ? `${JSON.stringify(key)}:` : '', item)
  }
  if (count < length) entries.push(keys ? `${JSON.stringify(TRUNCATED)}:` : '', TRUNCATED)

  ancestors.add(object)
  parts.push(keys ? '{' : '[')
  stack.push(LEAVE, object, WRITE_TEXT, keys ? '}' : ']')
  for (let i = entries.length - 2; i >= 0; i -= 2) {
    stack.push(WRITE_VALUE, entries[i + 1], WRITE_TEXT, `${i > 0 ? ',' : ''}${entries[i]}`)
  }
}

/**
 * @param {unknown} value
 */
function isLeftOut (value) {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

module.exports = { enable, disable }
