'use strict'

const { createHash } = require('node:crypto')
const { basename } = require('node:path')

const { storage } = require('../../../datadog-core')
const log = require('../log')

/**
 * @typedef {object} McpServer
 * @property {string} id
 * @property {'client'} managed_by
 * @property {string} [name]
 * @property {string} [url]
 * @property {'streamable_http'|'sse'|'stdio'|'in_process'|'unknown'} transport
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {Record<string, string>} [tools] The original MCP tool name of each model-visible function name.
 */

/**
 * @typedef {object} TransportInfo The raw transport values that the instrumentation reads.
 * @property {string} type
 * @property {unknown} [command]
 * @property {unknown} [args]
 * @property {unknown} [url]
 */

/**
 * @typedef {object} ListedTool
 * @property {number} clientId The ID of the MCP client that listed the tool.
 * @property {McpServer} server The server of the client, without tools.
 * @property {string} originalName
 */

/**
 * @typedef {object} ConversationMcp
 * @property {McpServer[]} servers The servers that the tool calls of the conversation reference.
 * @property {() => void} [onAllowed] Runs when the evaluation completes without a block.
 */

/**
 * @typedef {object} Mark
 * @property {number} clientId
 * @property {string} name The original MCP tool name.
 * @property {string} args The arguments in canonical form.
 */

/**
 * @typedef {{ context: () => { _trace: { started: unknown[] } } }} TraceSpan
 */

// Internal evaluate option. A symbol key keeps it out of the public evaluate options.
const MCP_SERVERS = Symbol('dd-trace.aiguard.mcpServers')

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }
// A host label that starts with xn-- is the punycode form of an IDN label.
const IDN_LABEL = /(?:^|\.)xn--/
const TRANSPORTS = new Set(['streamable_http', 'sse', 'stdio', 'in_process'])

// Package runners run the package of their first argument that is not a flag.
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx'])
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet'])
const PACKAGE_ID = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._+-]*)?$/i
const PYTHON = /^python(\d+(\.\d+)?)?$/
const PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

// A trace keeps a small number of marks. When the limit is reached, the oldest mark goes first and
// its tool call gets its own check.
const MAX_MARKS_PER_TRACE = 64

/** @type {WeakMap<object, ListedTool>} */
const toolsBySchema = new WeakMap()
let hasListedTools = false

/** @type {WeakMap<object, Mark[]>} */
const marksByTrace = new WeakMap()

// Records keep a small ID of the client and not the client itself. An application can keep listed
// schemas or traces for a long time, and a closed client must not stay in memory because of them.
/** @type {WeakMap<object, number>} */
const clientIds = new WeakMap()
let lastClientId = 0

/**
 * Returns the origin of a URL: the lowercase scheme and host, and the port when it is not the
 * default port of the scheme. It never keeps userinfo, path, parameters, query or fragment.
 * URL.prototype.origin is not used: it returns "null" for other schemes and keeps their host case.
 *
 * The MCP SDK gets URL objects that the platform already normalized, so the original spelling of
 * the host is gone. The tracers agree on this rule: an IP literal keeps its canonical form, and a
 * host with an IDN label gets no origin.
 *
 * @param {unknown} url
 * @returns {string|undefined} undefined when the URL is not valid, is relative, has no host, or has
 *   an IDN host.
 */
function urlOrigin (url) {
  if (typeof url !== 'string' || url === '') return

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return
  }

  const { protocol, hostname, port } = parsed
  if (!hostname) return

  // The parser lowercases the scheme, and the host of special schemes only.
  const host = hostname.toLowerCase()
  // The parser converts a Unicode host to punycode, so each IDN label starts with xn--.
  if (IDN_LABEL.test(host)) return
  return port === '' || DEFAULT_PORTS[protocol] === port ? `${protocol}//${host}` : `${protocol}//${host}:${port}`
}

/**
 * Returns the stdio arguments that are safe to send: the package that a package runner starts,
 * or the module that python -m starts. Other arguments can contain paths, tokens or secrets.
 *
 * @param {string} command
 * @param {unknown} args
 * @returns {string[]}
 */
function safeStdioArgs (command, args) {
  if (!Array.isArray(args)) return []

  let program = basename(command).toLowerCase()
  if (program.endsWith('.exe')) program = program.slice(0, -4)
  if (program.endsWith('.cmd')) program = program.slice(0, -4)

  if (PACKAGE_RUNNERS.has(program)) {
    for (const arg of args) {
      if (RUNNER_FLAGS.has(arg)) continue
      return typeof arg === 'string' && PACKAGE_ID.test(arg) ? [arg] : []
    }
    return []
  }

  if (PYTHON.test(program) && args.length >= 2 && args[0] === '-m') {
    const module = args[1]
    return typeof module === 'string' && PYTHON_MODULE.test(module) ? [module] : []
  }

  return []
}

/**
 * Returns the server ID from the first key that applies: the URL origin, then the stdio command
 * and its safe arguments, then the configured name. The transport is not part of the key.
 *
 * @param {{ url?: string, command?: string, args?: string[], name?: string }} server
 * @returns {string|undefined} undefined when no key applies.
 */
function mcpServerId ({ url, command, args = [], name }) {
  let key
  if (url) {
    key = `url|${url}`
  } else if (command) {
    key = ['stdio', command, ...args].join('|')
  } else if (name) {
    key = `name|${name}`
  } else {
    return
  }
  return 'mcp_' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Returns the URL of a remote transport as a string. The SDK keeps it as a URL object.
 *
 * @param {unknown} url
 * @returns {string|undefined}
 */
function urlString (url) {
  if (typeof url === 'string') return url
  const href = /** @type {{ href?: unknown }|undefined} */ (url)?.href
  return typeof href === 'string' ? href : undefined
}

/**
 * Builds the mcp_servers entry of a client-managed server from raw transport values. It keeps only
 * the URL origin and the safe stdio arguments. The entry has no tools: each request adds its own.
 *
 * @param {TransportInfo|undefined} info
 * @param {string} [name] The configured server name.
 * @returns {McpServer|undefined} undefined when no key identifies the server.
 */
function createClientServer (info, name) {
  const type = info?.type
  let url
  let command
  let args = []

  if (info?.type === 'stdio') {
    const stdioCommand = info.command
    if (typeof stdioCommand === 'string' && stdioCommand !== '') {
      command = stdioCommand
      args = safeStdioArgs(stdioCommand, info.args)
    }
  } else if (type !== 'in_process') {
    url = urlOrigin(urlString(info?.url))
  }

  const id = mcpServerId({ url, command, args, name })
  if (!id) return

  const transport = type && TRANSPORTS.has(type) ? /** @type {McpServer['transport']} */ (type) : 'unknown'
  /** @type {McpServer} */
  const server = { id, managed_by: 'client', transport }
  if (name) server.name = name
  if (url) server.url = url
  if (command) {
    server.command = command
    if (args.length > 0) server.args = args
  }
  return server
}

/**
 * @param {object} client
 */
function getClientId (client) {
  let id = clientIds.get(client)
  if (id === undefined) {
    id = ++lastClientId
    clientIds.set(client, id)
  }
  return id
}

/**
 * Records the input schema of each listed tool, so that a model request can link a function tool
 * to its MCP server by schema identity.
 *
 * @param {object} client
 * @param {McpServer|undefined} server
 * @param {unknown} tools
 */
function recordListedTools (client, server, tools) {
  if (!server || !Array.isArray(tools)) return

  const clientId = getClientId(client)
  for (const tool of tools) {
    const schema = tool?.inputSchema
    if (schema === null || typeof schema !== 'object' || typeof tool.name !== 'string') continue

    toolsBySchema.set(schema, { clientId, server, originalName: tool.name })
    hasListedTools = true
  }
}

/**
 * Returns the local trace of the active span.
 *
 * @returns {object|undefined}
 */
function activeTrace () {
  const span = /** @type {TraceSpan|undefined} */ (storage('legacy').getStore()?.span)
  return span?.context()._trace
}

/**
 * Returns the local trace that a later callTool of a model request shares, or undefined when there
 * is no outer operation. A model request span at the root of its trace has no outer operation.
 *
 * @param {{ tracingContext?: { currentStore?: { span?: TraceSpan } } }} interceptCtx
 * @returns {object|undefined}
 */
function getRequestTrace (interceptCtx) {
  const requestSpan = interceptCtx?.tracingContext?.currentStore?.span
  if (!requestSpan) return activeTrace()

  const trace = requestSpan.context()._trace
  return trace.started[0] === requestSpan ? undefined : trace
}

/**
 * Links the function tools of one model request to the MCP tools that a client listed. A function
 * tool links only when its parameters object is the listed input schema, never by its name alone.
 *
 * @param {unknown} requestTools
 * @param {(tool: object) => { name?: unknown, parameters?: unknown }|undefined} getFunction
 * @param {object} interceptCtx
 * @returns {McpToolLink|undefined} undefined when no tool links, or when no outer trace exists.
 */
function linkMcpTools (requestTools, getFunction, interceptCtx) {
  if (!hasListedTools || !Array.isArray(requestTools)) return

  let tools
  for (const requestTool of requestTools) {
    const fn = requestTool && getFunction(requestTool)
    const listed = fn && toolsBySchema.get(/** @type {object} */ (fn.parameters))
    if (listed && typeof fn.name === 'string') {
      tools ??= new Map()
      tools.set(fn.name, listed)
    }
  }
  if (!tools) return

  const trace = getRequestTrace(interceptCtx)
  return trace ? new McpToolLink(tools, trace) : undefined
}

/**
 * Returns JSON arguments in a canonical form with sorted object keys, or undefined when they are
 * not JSON. Validation can change the key order of the arguments before callTool, so the match of a
 * model tool call and a later callTool does not use the key order. Evaluations still send the
 * arguments in their own order.
 *
 * @param {unknown} text
 * @returns {string|undefined}
 */
function canonicalArguments (text) {
  if (typeof text !== 'string') return

  let args
  try {
    args = JSON.stringify(JSON.parse(text), sortKeys)
  } catch {
    // A call with such arguments gets its own check.
  }
  return args
}

/**
 * JSON.stringify replacer that writes the keys of each object in sorted order.
 *
 * @param {string} key
 * @param {unknown} value
 */
function sortKeys (key, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value

  const object = /** @type {Record<string, unknown>} */ (value)
  // A null prototype keeps a __proto__ key as an own property.
  const sorted = Object.create(null)
  for (const name of Object.keys(object).sort()) {
    sorted[name] = object[name]
  }
  return sorted
}

/**
 * @param {object} trace
 * @param {Mark} mark
 */
function addMark (trace, mark) {
  let marks = marksByTrace.get(trace)
  if (!marks) {
    marks = []
    marksByTrace.set(trace, marks)
  }
  if (marks.length >= MAX_MARKS_PER_TRACE) marks.shift()
  marks.push(mark)
}

/**
 * Removes the mark of a tool call that a model response evaluation already checked. It returns
 * true when a mark matched.
 *
 * @param {object|undefined} trace The local trace of the active span.
 * @param {object} client
 * @param {string} name The original MCP tool name.
 * @param {string} args The JSON arguments that callTool sends.
 */
function consumeMark (trace, client, name, args) {
  const marks = trace && marksByTrace.get(trace)
  const clientId = clientIds.get(client)
  if (!marks || clientId === undefined) return false

  let canonical
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    if (mark.clientId !== clientId || mark.name !== name) continue

    canonical ??= canonicalArguments(args)
    if (mark.args === canonical) {
      marks.splice(i, 1)
      return true
    }
  }
  return false
}

/**
 * The client-managed MCP tools of one model request, by model-visible name.
 */
class McpToolLink {
  #tools
  #trace

  /**
   * @param {Map<string, ListedTool>} tools
   * @param {object} trace The local trace that keeps the marks of the request.
   */
  constructor (tools, trace) {
    this.#tools = tools
    this.#trace = trace
  }

  /**
   * Returns the messages with an mcp reference on each tool call of a linked tool. It copies the
   * changed messages and tool calls, and keeps the objects of the application unchanged.
   *
   * @param {Array<object>} messages
   * @param {(toolCall: object) => boolean} isFunctionCall Selects the tool calls of function tools.
   *   Other tool calls, for example hosted MCP calls, never get a reference to a client server.
   * @returns {Array<object>} The same array when no tool call is linked, or when the copy fails.
   */
  attach (messages, isFunctionCall) {
    try {
      return this.#attach(messages, isFunctionCall)
    } catch (error) {
      // Without mcp references, the evaluation stays generic and the later callTool gets its own check.
      log.debug('AIGuard: unable to attach the MCP references: %s', error.message)
      return messages
    }
  }

  /**
   * @param {Array<object>} messages
   * @param {(toolCall: object) => boolean} isFunctionCall
   * @returns {Array<object>}
   */
  #attach (messages, isFunctionCall) {
    let attached
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      const toolCalls = message?.tool_calls
      if (!Array.isArray(toolCalls)) continue

      let attachedCalls
      for (let j = 0; j < toolCalls.length; j++) {
        const toolCall = toolCalls[j]
        const listed = this.#tools.get(toolCall?.function?.name)
        if (!listed || !isFunctionCall(toolCall)) continue

        attachedCalls ??= [...toolCalls]
        attachedCalls[j] = { ...toolCall, mcp: { server_id: listed.server.id } }
      }
      if (!attachedCalls) continue

      attached ??= [...messages]
      attached[i] = { ...message, tool_calls: attachedCalls }
    }
    return attached ?? messages
  }

  /**
   * Returns the MCP options of one evaluation.
   *
   * @param {Array<object>} conversation The evaluated messages, after attach.
   * @param {Array<object>} [outputs] The model outputs. They get marks when the evaluation allows them.
   * @returns {ConversationMcp|undefined} undefined when no tool call references a server.
   */
  evaluation (conversation, outputs) {
    const servers = this.#referencedServers(conversation)
    if (!servers) return
    return outputs ? { servers, onAllowed: () => this.#mark(outputs) } : { servers }
  }

  /**
   * Returns the servers that the tool calls reference, each with only the tools that they call.
   *
   * @param {Array<object>} messages
   * @returns {McpServer[]|undefined}
   */
  #referencedServers (messages) {
    // Clients can reach the same server, so the entries merge by server ID.
    /** @type {Map<string, { server: McpServer, tools: Record<string, string> }>|undefined} */
    let referenced
    for (const message of messages) {
      const toolCalls = message?.tool_calls
      if (!Array.isArray(toolCalls)) continue

      for (const toolCall of toolCalls) {
        const name = toolCall?.function?.name
        const listed = toolCall?.mcp && this.#tools.get(name)
        if (!listed || listed.server.id !== toolCall.mcp.server_id) continue

        referenced ??= new Map()
        let entry = referenced.get(listed.server.id)
        if (!entry) {
          entry = { server: listed.server, tools: {} }
          referenced.set(listed.server.id, entry)
        }
        entry.tools[name] = listed.originalName
      }
    }
    if (!referenced) return

    const servers = []
    for (const { server, tools } of referenced.values()) {
      servers.push({ ...server, tools })
    }
    return servers
  }

  /**
   * Marks each MCP tool call of the outputs. A later callTool with the same client, tool and
   * arguments in the same trace then skips its own evaluation.
   *
   * @param {Array<object>} outputs
   */
  #mark (outputs) {
    for (const message of outputs) {
      const toolCalls = message?.tool_calls
      if (!Array.isArray(toolCalls)) continue

      for (const toolCall of toolCalls) {
        const listed = toolCall?.mcp && this.#tools.get(toolCall.function?.name)
        if (!listed) continue

        const args = canonicalArguments(toolCall.function.arguments)
        if (args !== undefined) {
          addMark(this.#trace, { clientId: listed.clientId, name: listed.originalName, args })
        }
      }
    }
  }
}

module.exports = {
  MCP_SERVERS,
  McpToolLink,
  activeTrace,
  consumeMark,
  createClientServer,
  linkMcpTools,
  recordListedTools,
}
