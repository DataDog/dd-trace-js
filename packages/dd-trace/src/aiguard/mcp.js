'use strict'

const { createHash } = require('node:crypto')
const { basename } = require('node:path')

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

module.exports = {
  MCP_SERVERS,
  createClientServer,
}
