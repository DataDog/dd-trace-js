'use strict'

const { randomUUID } = require('node:crypto')
const { types } = require('node:util')

const { channel, tracingChannel } = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { MCP_SERVERS, activeTrace, consumeMark, createClientServer, recordListedTools } = require('../mcp')
const { SOURCE_AUTO } = require('../tags')

const callToolInterceptChannel = channel('dd-trace:mcp:callTool:intercept')
const listToolsResultChannel = channel('dd-trace:mcp:listTools:result')
// The rewriter adds these channels to the public MCP server classes of @openai/agents-core. The tool
// calls of a server object run in the store that this integration binds on their start channels.
const agentsMcpServerCallChannels = []
for (const className of ['MCPServerStdio', 'MCPServerStreamableHttp', 'MCPServerSSE']) {
  for (const methodName of ['callTool', 'callToolResult']) {
    agentsMcpServerCallChannels.push(tracingChannel(`orchestrion:@openai/agents-core:${className}_${methodName}`).start)
  }
}

const legacyStorage = storage('legacy')
const AGENTS_MCP_SERVER = Symbol('dd-trace.aiguard.agentsMcpServer')

// @openai/agents makes these names when the application sets no name. They contain the raw command or URL.
const GENERATED_NAME_PREFIXES = ['stdio: ', 'sse: ', 'streamable-http: ']
// These transports send the JSON form of the params, so the server gets exactly that form.
const JSON_TRANSPORTS = new Set(['stdio', 'sse', 'streamable_http', 'websocket'])
const CYCLE = '[Circular]'
const UNREADABLE = '[Unreadable]'
const TRUNCATED = '[Truncated]'
// The JSON text that the check gets has at most this many entries. The cap bounds the check, not
// the call: model output is far smaller, and only a large value of the application goes past it.
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
 * @property {string} args The JSON arguments to evaluate.
 * @property {object|undefined} params The copy of the params that the SDK sends. Without a copy, the
 *   SDK sends the params of the application.
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

/** @type {WeakMap<object, Map<string|undefined, McpServer|undefined>>} */
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
  for (const startChannel of agentsMcpServerCallChannels) startChannel.bindStore(legacyStorage, bindAgentsMcpServer)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  callToolInterceptChannel.unsubscribe(onCallTool)
  listToolsResultChannel.unsubscribe(onListToolsResult)
  for (const startChannel of agentsMcpServerCallChannels) startChannel.unbindStore(legacyStorage)

  aiguard = undefined
  opts = undefined
  isEnabled = false
}

/**
 * Keeps the current store and adds the MCP server object of `@openai/agents` that makes the call.
 *
 * @param {{ self?: object }} ctx The context of the rewritten method.
 */
function bindAgentsMcpServer (ctx) {
  return { ...legacyStorage.getStore(), [AGENTS_MCP_SERVER]: ctx?.self }
}

/**
 * Returns the server name that the application configured for the `@openai/agents` MCP server that
 * makes the current call. It reads only the public name of the server object.
 *
 * @returns {string|undefined} undefined without a configured name.
 */
function getConfiguredServerName () {
  const store = /** @type {Record<symbol, { name?: unknown }|undefined>|undefined} */ (legacyStorage.getStore())
  const server = store?.[AGENTS_MCP_SERVER]
  if (!server) return

  let name
  try {
    name = server.name
  } catch {
    return
  }
  if (typeof name !== 'string' || name === '') return
  for (const prefix of GENERATED_NAME_PREFIXES) {
    if (name.startsWith(prefix)) return
  }
  return name
}

/**
 * Returns the server of a client transport. The entries stay the same for the life of the
 * transport, with one entry for each configured name.
 *
 * @param {unknown} transport
 * @param {TransportInfo|undefined} info
 * @param {string} [name] The configured server name.
 * @returns {McpServer|undefined}
 */
function resolveServer (transport, info, name) {
  if (transport === null || typeof transport !== 'object') return createClientServer(info, name)

  let servers = serversByTransport.get(transport)
  if (!servers) {
    servers = new Map()
    serversByTransport.set(transport, servers)
  }
  if (servers.has(name)) return servers.get(name)

  const server = createClientServer(info, name)
  servers.set(name, server)
  return server
}

/**
 * @param {{ client: object, transport: unknown, transportInfo: TransportInfo|undefined, tools: unknown }} ctx
 */
function onListToolsResult (ctx) {
  try {
    recordListedTools(ctx.client, resolveServer(ctx.transport, ctx.transportInfo), ctx.tools)
  } catch (error) {
    log.debug('AIGuard: unable to record the listed MCP tools: %s', error.message)
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
    log.debug('AIGuard: unable to evaluate the MCP tool call: %s', error.message)
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
 * already checked in the same trace gets no second evaluation.
 *
 * @param {CallToolContext} ctx
 * @returns {Promise<unknown>|undefined}
 */
function evaluateToolCall (ctx) {
  const params = /** @type {{ name?: unknown, arguments?: unknown }|undefined} */ (ctx.arguments[0])
  // Without params or a tool name, the request selects no tool, so no tool can run.
  if (params === null || typeof params !== 'object') return
  // The check and the copy use one read of each value of the application.
  const toolName = params.name
  if (toolName === undefined) return

  const name = typeof toolName === 'string' ? toolName : String(toolName)
  const call = prepareCall(params, toolName, ctx.transportInfo)

  // The SDK sends the copy, also for a call that starts at once. Then a change to the params of
  // the application after callTool returns cannot reach the server.
  if (call.params) ctx.arguments[0] = call.params

  if (consumeMark(activeTrace(), ctx.client, name, call.args)) return

  // No model call ID exists for a direct call, so the call gets a local ID.
  /** @type {{ id: string, function: { name: string, arguments: string }, mcp?: { server_id: string } }} */
  const toolCall = { id: `dd_mcp_${randomUUID().replaceAll('-', '')}`, function: { name, arguments: call.args } }
  const messages = [{ role: 'assistant', tool_calls: [toolCall] }]
  const server = resolveServer(ctx.transport, ctx.transportInfo, getConfiguredServerName())
  // A server that no key identifies gets the evaluation of an ordinary tool call.
  if (!server) return aiguard.evaluate(messages, opts)

  toolCall.mcp = { server_id: server.id }
  return aiguard.evaluate(messages, { ...opts, [MCP_SERVERS]: [{ ...server, tools: { [name]: name } }] })
}

/**
 * Returns the arguments to evaluate and the copy of the params that the SDK sends. The copy comes
 * first, and the evaluation reads the copy.
 *
 * A JSON transport sends the JSON form of the arguments, so the copy gets that same form. Other
 * transports can give the server the objects themselves. Then the copy is a structured clone that
 * keeps the data and its types, and the evaluation gets the content of the clone.
 *
 * @param {{ name?: unknown, arguments?: unknown }} params
 * @param {unknown} toolName The tool name that the check read.
 * @param {TransportInfo|undefined} info
 * @returns {PreparedCall}
 */
function prepareCall (params, toolName, info) {
  const callArguments = params.arguments
  if (!JSON_TRANSPORTS.has(/** @type {string} */ (info?.type))) {
    const checked = checkArguments(callArguments)
    return { args: checked.text ?? '{}', params: copyParams(params, toolName, checked.value) }
  }

  let json
  try {
    json = JSON.stringify(callArguments)
  } catch {
    // The SDK serializes the params of the application again. Usually it fails on the same value,
    // for example a BigInt, but a value that fails only once can still go to the server.
    return { args: safeJson(callArguments) ?? '{}', params: undefined }
  }
  // JSON leaves out an undefined value or a function, so the server gets no arguments.
  if (json === undefined) return { args: '{}', params: copyParams(params, toolName, callArguments) }
  return { args: json, params: copyParams(params, toolName, JSON.parse(json)) }
}

/**
 * Returns a copy of the params with the tool name and the arguments that the check read. It reads
 * each other value of the params once and keeps the order of the keys. It returns undefined when a
 * read throws. Then the SDK sends the params of the application.
 *
 * @param {object} params
 * @param {unknown} toolName
 * @param {unknown} args
 * @returns {object|undefined}
 */
function copyParams (params, toolName, args) {
  // Only the name and the arguments are snapshots. The check does not read the other keys, for
  // example _meta, so they stay shallow copies.
  const source = /** @type {Record<string, unknown>} */ (params)
  /** @type {Record<string, unknown>} */
  const copy = {}
  try {
    for (const key of Object.keys(source)) {
      if (key === 'name') {
        copy.name = toolName
      } else if (key === 'arguments') {
        if (args !== undefined) copy.arguments = args
      } else {
        setValue(copy, key, source[key])
      }
    }
  } catch {
    // A getter of the params throws. The SDK meets the same getter.
    return
  }
  // The params can inherit the name or the arguments.
  copy.name = toolName
  if (args !== undefined) copy.arguments = args
  return copy
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
