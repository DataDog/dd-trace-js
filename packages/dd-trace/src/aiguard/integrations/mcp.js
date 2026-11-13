'use strict'

const { randomUUID } = require('node:crypto')

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
 * transports can give the server the objects themselves. Then the copy keeps the values and their
 * types, and the evaluation gets a JSON form that never fails.
 *
 * @param {{ name?: unknown, arguments?: unknown }} params
 * @param {unknown} toolName The tool name that the check read.
 * @param {TransportInfo|undefined} info
 * @returns {PreparedCall}
 */
function prepareCall (params, toolName, info) {
  const callArguments = params.arguments
  if (!JSON_TRANSPORTS.has(/** @type {string} */ (info?.type))) {
    let copy
    try {
      copy = copyValue(callArguments, new Map())
    } catch {
      // The value is too deep to copy. The SDK sends the params of the application.
      return { args: safeJson(callArguments) ?? '{}', params: undefined }
    }
    return {
      args: copy === undefined ? '{}' : (safeJson(copy) ?? '{}'),
      params: copyParams(params, toolName, copy),
    }
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
 * Returns a copy of the plain objects and the plain arrays in a value. Other values stay as they
 * are, for example a Date, a Buffer, a Map or a class instance. Values that the original shares, and
 * cycles, are shared in the copy too. An object with a value that it cannot read stays as it is.
 *
 * @param {unknown} value
 * @param {Map<object, unknown>} copies The copy of each object that the copy already contains.
 * @returns {unknown}
 */
function copyValue (value, copies) {
  if (value === null || typeof value !== 'object') return value
  if (copies.has(value)) return copies.get(value)

  let prototype
  let isArray
  let keys
  const values = []
  try {
    prototype = Object.getPrototypeOf(value)
    isArray = Array.isArray(value) && prototype === Array.prototype
    if (!isArray && prototype !== Object.prototype && prototype !== null) return value

    // The copy reads all values of the object before it copies them. Then no copy refers to an
    // object that has only some of its values.
    if (isArray) {
      const { length } = /** @type {unknown[]} */ (value)
      for (let i = 0; i < length; i++) values.push(/** @type {unknown[]} */ (value)[i])
    } else {
      keys = Object.keys(value)
      for (const key of keys) values.push(/** @type {Record<string, unknown>} */ (value)[key])
    }
  } catch {
    // A getter or a proxy trap throws. The object stays as it is.
    copies.set(value, value)
    return value
  }

  if (isArray) {
    const copy = []
    copies.set(value, copy)
    for (const item of values) copy.push(copyValue(item, copies))
    return copy
  }

  const copy = prototype === null ? Object.create(null) : {}
  copies.set(value, copy)
  for (let i = 0; i < values.length; i++) {
    setValue(copy, /** @type {string[]} */ (keys)[i], copyValue(values[i], copies))
  }
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
 * Returns the JSON form of values that an in-process server can get as they are. A value that JSON
 * cannot represent gets a readable form: a BigInt becomes its decimal string, and a cycle or a
 * value that throws becomes a placeholder.
 *
 * @param {unknown} value
 * @returns {string|undefined} undefined for a value that JSON leaves out, for example a function.
 */
function safeJson (value) {
  try {
    return JSON.stringify(value)
  } catch {
    // The value has a BigInt, a cycle, or a part that throws.
  }
  try {
    return JSON.stringify(toJsonValue(value, '', []))
  } catch {
    return JSON.stringify(UNREADABLE)
  }
}

/**
 * Returns a value that JSON.stringify can always write.
 *
 * @param {unknown} value
 * @param {string} key The key of the value in its parent, for toJSON.
 * @param {object[]} ancestors The objects that contain the value.
 * @returns {unknown}
 */
function toJsonValue (value, key, ancestors) {
  if (value !== null && (typeof value === 'object' || typeof value === 'bigint')) {
    try {
      const toJSON = /** @type {{ toJSON?: unknown }} */ (value).toJSON
      if (typeof toJSON === 'function') value = toJSON.call(value, key)
    } catch {
      return UNREADABLE
    }
  }
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (ancestors.includes(value)) return CYCLE

  ancestors.push(value)
  try {
    if (Array.isArray(value)) {
      const items = []
      for (let i = 0; i < value.length; i++) {
        items.push(readJsonValue(value, i, ancestors))
      }
      return items
    }

    // A null prototype keeps a __proto__ key as an own property.
    const result = Object.create(null)
    for (const name of Object.keys(value)) {
      result[name] = readJsonValue(value, name, ancestors)
    }
    return result
  } catch {
    return UNREADABLE
  } finally {
    ancestors.pop()
  }
}

/**
 * @param {object} holder
 * @param {string|number} key
 * @param {object[]} ancestors
 */
function readJsonValue (holder, key, ancestors) {
  let value
  try {
    value = /** @type {Record<string|number, unknown>} */ (holder)[key]
  } catch {
    return UNREADABLE
  }
  return toJsonValue(value, String(key), ancestors)
}

module.exports = { enable, disable }
