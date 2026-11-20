'use strict'

const { createHash } = require('node:crypto')

/**
 * @typedef {object} McpServer
 * @property {string} id
 * @property {'client'|'provider'} managed_by
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

// Internal evaluate option. A symbol key keeps it out of the public evaluate options.
const MCP_SERVERS = Symbol('dd-trace.aiguard.mcpServers')

// A host label that starts with xn-- is the punycode form of an IDN label.
const IDN_LABEL = /(?:^|\.)xn--/
const TRANSPORTS = new Set(['streamable_http', 'sse', 'stdio', 'in_process'])

// Package runners run the package of their first argument that is not a flag.
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx'])
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet'])
const PACKAGE_ID = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._+-]*)?$/i
const PYTHON = /^python(\d+(\.\d+)?)?$/
const PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

/**
 * Returns the origin of a URL: the lowercase scheme and host, and the port when it is not the
 * default port of the scheme. The parser already drops the default port of the special schemes.
 * It never keeps userinfo, path, parameters, query or fragment.
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
  return port === '' ? `${protocol}//${host}` : `${protocol}//${host}:${port}`
}

/**
 * Returns the program name of a stdio command: its last path segment, split on a slash or a
 * backslash on every platform, lowercase, without a .exe or .cmd suffix. A full path can hold the
 * user name and changes from machine to machine.
 *
 * @param {string} command
 */
function stdioProgram (command) {
  const start = Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\')) + 1
  let program = command.slice(start).toLowerCase()
  if (program.endsWith('.exe')) program = program.slice(0, -4)
  if (program.endsWith('.cmd')) program = program.slice(0, -4)
  return program
}

/**
 * Returns the stdio arguments that are safe to send: the package that a package runner starts,
 * or the module that python -m starts. Other arguments can contain paths, tokens or secrets.
 *
 * @param {string} program The program name of the command, see stdioProgram.
 * @param {unknown} args
 * @returns {string[]}
 */
function safeStdioArgs (program, args) {
  if (!Array.isArray(args)) return []

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
 * Returns the server ID from the first key that applies: the URL origin, then the connector ID,
 * then the stdio program and its safe arguments, then the configured name. The transport and
 * managed_by are not part of the key.
 *
 * @param {{ url?: string, connectorId?: string, command?: string, args?: string[], name?: string }} server
 * @returns {string|undefined} undefined when no key applies.
 */
function mcpServerId ({ url, connectorId, command, args = [], name }) {
  let key
  if (url) {
    key = `url|${url}`
  } else if (connectorId) {
    key = `connector|${connectorId}`
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
 * Builds an mcp_servers entry with no tools: each request adds its own. The URL is reported as its
 * origin only, and the command as its program name.
 *
 * @param {McpServer['managed_by']} managedBy
 * @param {McpServer['transport']} transport
 * @param {{ name?: string, url?: unknown, connectorId?: string, command?: string, args?: string[] }} [fields]
 *   args must only hold safe values, see safeStdioArgs; they are ignored without a command.
 * @returns {McpServer|undefined} undefined when no key identifies the server.
 */
function createServer (managedBy, transport, { name, url, connectorId, command, args = [] } = {}) {
  const origin = urlOrigin(urlString(url))
  const program = command ? stdioProgram(command) || undefined : undefined
  const safeArgs = program ? args : []

  const id = mcpServerId({ url: origin, connectorId, command: program, args: safeArgs, name })
  if (!id) return

  /** @type {McpServer} */
  const server = { id, managed_by: managedBy, transport }
  if (name) server.name = name
  if (origin) server.url = origin
  if (program) {
    server.command = program
    if (safeArgs.length > 0) server.args = safeArgs
  }
  return server
}

/**
 * Builds the mcp_servers entry of a client-managed server from raw transport values. It keeps only
 * the URL origin, the program name and the safe stdio arguments.
 *
 * @param {TransportInfo|undefined} info
 * @param {string} [name] The configured server name.
 * @returns {McpServer|undefined} undefined when no key identifies the server.
 */
function createClientServer (info, name) {
  const type = info?.type
  const transport = type && TRANSPORTS.has(type) ? /** @type {McpServer['transport']} */ (type) : 'unknown'

  if (info?.type === 'stdio') {
    const command = typeof info.command === 'string' ? info.command : undefined
    const args = command ? safeStdioArgs(stdioProgram(command), info.args) : []
    return createServer('client', transport, { name, command, args })
  }
  return createServer('client', transport, { name, url: type === 'in_process' ? undefined : info?.url })
}

module.exports = {
  MCP_SERVERS,
  createClientServer,
  createServer,
}
