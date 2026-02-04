'use strict'

// Guard against double-patching when this file is loaded multiple times
// (e.g., via both --require and ritm hooks, or in test setup and subprocess).
if (globalThis._ddChannelDebugPatched) return
globalThis._ddChannelDebugPatched = true

const dc = require('node:diagnostics_channel')
const { performance } = require('node:perf_hooks')
const Module = require('node:module')

const Hook = require('../../src/ritm')

// Use TEST_ prefix to avoid confusion with production DD_ config variables
const filter = process.env.TEST_CHANNEL_FILTER || ''
const showData = process.env.TEST_CHANNEL_SHOW_DATA === 'true'
const verbose = process.env.TEST_CHANNEL_VERBOSE === 'true'
const forceColor = process.env.FORCE_COLOR === '1'
const noColor = (!process.stderr.isTTY && !forceColor) || process.env.NO_COLOR
const startTime = performance.now()

const identity = s => s
const colors = noColor
  ? {
      cyan: identity,
      yellow: identity,
      green: identity,
      gray: identity,
      blue: identity,
      red: identity,
      magenta: identity,
      white: identity,
    }
  : {
      cyan: s => `\x1b[36m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      green: s => `\x1b[32m${s}\x1b[0m`,
      gray: s => `\x1b[90m${s}\x1b[0m`,
      blue: s => `\x1b[34m${s}\x1b[0m`,
      red: s => `\x1b[31m${s}\x1b[0m`,
      magenta: s => `\x1b[35m${s}\x1b[0m`,
      white: s => `\x1b[37m${s}\x1b[0m`,
    }

const indent = '                    ' // 20 spaces - well past mocha's indentation

/**
 * Writes content to stderr synchronously to prevent interleaving with stdout.
 * @param {string} content - The content to write (can contain newlines)
 */
function log (content) {
  const indented = content.split('\n').map(line => indent + line).join('\n')
  process.stderr.write(indented + '\n')
}

/**
 * Converts a wildcard pattern to a RegExp.
 * @param {string} pattern - Wildcard pattern (e.g., `*foo*`, `foo*`, `*foo`)
 * @returns {RegExp} Compiled regular expression
 */
function wildcardToRegex (pattern) {
  // Escape regex special chars except *, then convert * to .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

// Pre-compile filter regex for performance (null if no filter)
const filterRegex = filter ? wildcardToRegex(filter) : null

/**
 * Checks if a channel name matches the configured filter pattern.
 * Supports wildcard patterns: `*foo*` (contains), `*foo` (ends with), `foo*` (starts with).
 * @param {string} name - The channel name to check
 * @returns {boolean} True if the name matches the filter or no filter is set
 */
function match (name) {
  if (!filterRegex) return true
  return filterRegex.test(name)
}

/**
 * Formats the elapsed time since module load as a timestamp string.
 * @returns {string} Gray-colored timestamp in format `[+Nms]`
 */
function formatTimestamp () {
  return colors.gray(`[+${(performance.now() - startTime).toFixed(0)}ms]`)
}

/**
 * Formats the duration since a given start time.
 * @param {number} start - The start time from performance.now()
 * @returns {string} Gray-colored duration in format `N.NNms`
 */
function formatDuration (start) {
  return colors.gray(`${(performance.now() - start).toFixed(2)}ms`)
}

// ============================================================
// Channel Prototype Patching
// ============================================================

// Node.js optimizes diagnostics_channel - when channels HAVE subscribers,
// publish() uses a native C++ fast path that bypasses JS-level prototype methods.
// Our Channel.prototype.publish patch only runs when there are NO subscribers.
// To log all publishes, we wrap subscriber functions to log when they're called.
// WeakMap tracks original→wrapped mapping for proper unsubscribe support.

const { subscribe, unsubscribe, publish } = dc.Channel.prototype
const subscriberWrappers = new WeakMap()

/**
 * Creates a logging wrapper around a subscriber function.
 * The wrapper logs the publish event before calling the original subscriber.
 * @param {Function} fn - The original subscriber function
 * @param {string} channelName - The channel name for logging
 * @returns {Function} The wrapped subscriber function
 */
function wrapSubscriber (fn, channelName) {
  const wrapped = function (msg) {
    if (match(channelName)) {
      let output = `${formatTimestamp()} ${colors.yellow('[PUB]')} ${colors.cyan(channelName)}`
      if (showData && msg) output += ` ${colors.gray(JSON.stringify(msg).slice(0, 80))}`
      log(output)
    }
    return fn.apply(this, arguments)
  }
  // Store mapping for unsubscribe lookup
  subscriberWrappers.set(fn, wrapped)
  return wrapped
}

dc.Channel.prototype.subscribe = function (fn) {
  if (match(this.name)) {
    const handler = colors.gray(`← ${fn.name || 'anon'}`)
    log(`${formatTimestamp()} ${colors.blue('[SUB]')} ${colors.cyan(this.name)} ${handler}`)
  }
  // Wrap subscriber to log publishes (needed because native fast path bypasses JS publish)
  const wrapped = wrapSubscriber(fn, this.name)
  return subscribe.call(this, wrapped)
}

dc.Channel.prototype.unsubscribe = function (fn) {
  // Look up the wrapped version we created during subscribe
  const wrapped = subscriberWrappers.get(fn) || fn
  if (match(this.name)) {
    const handler = colors.gray(`← ${fn.name || 'anon'}`)
    log(`${formatTimestamp()} ${colors.gray('[UNSUB]')} ${colors.cyan(this.name)} ${handler}`)
  }
  return unsubscribe.call(this, wrapped)
}

dc.Channel.prototype.publish = function (msg) {
  // This only runs when there are NO subscribers (native fast path bypasses this otherwise)
  if (match(this.name)) {
    let output = `${formatTimestamp()} ${colors.yellow('[PUB]')} ${colors.cyan(this.name)}`
    output += colors.red(' (no subscribers)')
    if (showData && msg) output += ` ${colors.gray(JSON.stringify(msg).slice(0, 80))}`
    log(output)
  }
  return publish.call(this, msg)
}

// Wrap module-level dc.subscribe/dc.unsubscribe as they don't go through prototype.
// These APIs are available from Node.js 18.7.0+ (test-only code, so acceptable).
/* eslint-disable n/no-unsupported-features/node-builtins */
if (dc.subscribe) {
  const origDcSubscribe = dc.subscribe
  dc.subscribe = function (name, fn) {
    if (match(name)) {
      const handler = colors.gray(`← ${fn.name || 'anon'}`)
      log(`${formatTimestamp()} ${colors.blue('[SUB]')} ${colors.cyan(name)} ${handler}`)
    }
    // Wrap subscriber to log publishes (needed because native fast path bypasses JS publish)
    const wrapped = wrapSubscriber(fn, name)
    return origDcSubscribe.call(this, name, wrapped)
  }
}

if (dc.unsubscribe) {
  const origDcUnsubscribe = dc.unsubscribe
  dc.unsubscribe = function (name, fn) {
    // Look up the wrapped version we created during subscribe
    const wrapped = subscriberWrappers.get(fn) || fn
    if (match(name)) {
      const handler = colors.gray(`← ${fn.name || 'anon'}`)
      log(`${formatTimestamp()} ${colors.gray('[UNSUB]')} ${colors.cyan(name)} ${handler}`)
    }
    return origDcUnsubscribe.call(this, name, wrapped)
  }
}
/* eslint-enable n/no-unsupported-features/node-builtins */

// NOTE: runStores patching was removed because it causes test timeouts.
// TracingChannel caches runStores at creation time, and wrapping dc.channel()
// to patch instances breaks async context propagation.
// Use [TRACEPROMISE]/[TRACESYNC]/[TRACECALLBACK] logs instead.

// ============================================================
// TracingChannel Patching (dc-polyfill)
// ============================================================

// ritm hooks can fire multiple times for the same module (e.g., when required
// from different paths or when module cache is cleared in tests). The
// _channelDebugPatched guard prevents re-wrapping already-patched exports.
Hook(['dc-polyfill'], exports => {
  if (exports._channelDebugPatched) return exports
  exports._channelDebugPatched = true
  const orig = exports.tracingChannel
  exports.tracingChannel = function (name) {
    const tracingChannel = orig.call(this, name)
    // TracingChannels are cached by name, so the same object can be returned
    // on repeated calls - guard against re-patching the same instance.
    if (tracingChannel._channelDebugPatched) return tracingChannel
    tracingChannel._channelDebugPatched = true
    for (const method of ['traceSync', 'tracePromise', 'traceCallback']) {
      const fn = tracingChannel[method]
      if (fn) {
        tracingChannel[method] = function (...args) {
          if (!match(name)) return fn.apply(this, args)
          const start = performance.now()
          const result = fn.apply(this, args)
          const tag = colors.magenta(`[${method.toUpperCase()}]`)
          log(`${formatTimestamp()} ${tag} ${colors.cyan(name)} ${formatDuration(start)}`)
          return result
        }
      }
    }
    return tracingChannel
  }
  return exports
})

// ============================================================
// Shimmer Patching
// ============================================================

/**
 * Patches shimmer's wrap/massWrap functions to log method wrapping operations.
 * Guard against re-patching since ritm hooks can fire multiple times.
 * @param {object} exports - The shimmer module exports
 * @returns {object} The patched exports
 */
function patchShimmer (exports) {
  if (exports._channelDebugPatched) return exports
  exports._channelDebugPatched = true
  const origWrap = exports.wrap
  exports.wrap = function (obj, method, wrapper) {
    const objName = obj?.constructor?.name || typeof obj
    if (match(method) || match(objName)) {
      log(`${formatTimestamp()} ${colors.magenta('[WRAP]')} ${colors.yellow(objName)}.${colors.cyan(method)}`)
    }
    return origWrap.call(this, obj, method, wrapper)
  }
  if (exports.massWrap) {
    const origMass = exports.massWrap
    exports.massWrap = function (obj, methods, wrapper) {
      const objName = obj?.constructor?.name || typeof obj
      for (const method of methods) {
        if (match(method) || match(objName)) {
          log(`${formatTimestamp()} ${colors.magenta('[WRAP]')} ${colors.yellow(objName)}.${colors.cyan(method)}`)
        }
      }
      return origMass.call(this, obj, methods, wrapper)
    }
  }
  return exports
}

Hook(['shimmer', 'datadog-shimmer'], patchShimmer)

// ============================================================
// Rewriter Patching
// ============================================================

let instrumentations = []
try {
  instrumentations = require('../../../datadog-instrumentations/src/helpers/rewriter/instrumentations')
} catch {
  // Module not available in all test environments
}

/**
 * Maps a function kind to its corresponding tracing operator.
 * @param {string} kind - The function kind ('Async', 'Callback', or other)
 * @returns {string} The tracing operator name
 */
function getOperator (kind) {
  if (kind === 'Async') return 'tracePromise'
  if (kind === 'Callback') return 'traceCallback'
  return 'traceSync'
}

/**
 * Patches the rewriter module to log code rewrite operations.
 * Called from both direct require and Module._load hook, so guard against re-patching.
 * @param {object} exports - The rewriter module exports
 */
function patchRewriter (exports) {
  if (!exports?.rewrite || exports._channelDebugPatched) return
  exports._channelDebugPatched = true

  const origRewrite = exports.rewrite
  exports.rewrite = function (content, filename, format) {
    const result = origRewrite.call(this, content, filename, format)
    if (result !== content) {
      const cleanFilename = filename.replace('file://', '')
      for (const inst of instrumentations) {
        const { functionQuery = {}, module: mod, channelName } = inst
        const { className, methodName, kind } = functionQuery
        const operator = getOperator(kind)

        if (cleanFilename.endsWith(`${mod.name}/${mod.filePath}`)) {
          const target = className ? `${className}.${methodName}` : methodName || channelName
          if (match(mod.name) || match(target) || match(channelName)) {
            const parts = [
              separator,
              `${formatTimestamp()} ${colors.magenta('[REWRITE]')} ${colors.cyan(mod.name)}`,
              `${colors.yellow(target)} ${colors.blue(operator)} ${colors.gray(mod.filePath)}`,
            ]
            log(parts.join('\n'))
          }
        }
      }
    }
    return result
  }
}

try {
  const rewriter = require('../../../datadog-instrumentations/src/helpers/rewriter')
  patchRewriter(rewriter)
} catch {
  // Module not available in all test environments
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const exports = origLoad.apply(this, arguments)
  if (request.includes('rewriter') && exports?.rewrite) {
    patchRewriter(exports)
  }
  return exports
}

// ============================================================
// Span Lifecycle Logging (via diagnostic channels)
// ============================================================

const skipTags = new Set([
  'runtime-id', 'process_id',
  // Already displayed on main span line
  'service.name', 'resource.name', 'span.kind', 'error',
])

/**
 * Formats a short span ID for display (last 8 hex characters).
 * Helps correlate span start/end events when multiple spans run in parallel.
 * @param {object} span - The span object
 * @returns {string} Formatted span ID or empty string if unavailable
 */
function formatSpanId (span) {
  const spanId = span?._spanContext?._spanId
  if (!spanId) return ''
  const hex = spanId.toString(16).padStart(16, '0')
  return colors.gray(`[${hex.slice(-8)}]`)
}

/**
 * Formats span tags for display, filtering out common/internal tags.
 * Groups tags on indented lines (3 per line) for readability.
 * Only outputs tags when TEST_CHANNEL_VERBOSE=true.
 * @param {object} tags - The span tags object
 * @returns {string} Formatted tag string or empty string if no relevant tags
 */
function formatSpanMeta (tags) {
  if (!verbose || !tags) return ''
  const meta = []
  for (const [key, value] of Object.entries(tags)) {
    if (skipTags.has(key) || key.startsWith('_dd') || value === undefined || value === null) continue
    let displayValue = value
    if (typeof value === 'object') {
      try {
        displayValue = JSON.stringify(value)
      } catch {
        // Circular reference or other serialization error
        displayValue = String(value)
      }
    }
    if (typeof displayValue === 'string' && displayValue.length > 50) {
      displayValue = displayValue.slice(0, 47) + '...'
    }
    meta.push(`${key}=${displayValue}`)
  }
  if (!meta.length) return ''
  // Group 3 tags per line with indentation
  const lines = []
  for (let i = 0; i < meta.length; i += 3) {
    lines.push('    ' + meta.slice(i, i + 3).join('  '))
  }
  return '\n' + colors.gray(lines.join('\n'))
}

const separator = noColor ? '────────────────────' : '\x1b[90m────────────────────\x1b[0m'

// Subscribe to tracer's built-in span lifecycle channels using Channel API
// for more reliable subscription timing across CJS/ESM loading scenarios.
const spanStartCh = dc.channel('dd-trace:span:start')
const spanFinishCh = dc.channel('dd-trace:span:finish')

spanStartCh.subscribe(({ span, fields }) => {
  const name = fields.operationName
  if (!match(name)) return
  const tags = span?._spanContext?._tags || fields.tags || {}
  const service = tags['service.name'] || ''
  const resource = tags['resource.name'] || ''
  const kind = tags['span.kind'] || ''
  const meta = formatSpanMeta(tags)
  const resourcePart = resource ? colors.blue(` ${resource}`) : ''
  const kindPart = kind ? colors.magenta(` ${kind}`) : ''
  const spanIdPart = formatSpanId(span)
  const tag = colors.green('[SPAN:START]')
  const spanInfo = `${colors.white(name)} ${spanIdPart} ${colors.cyan(service)}${resourcePart}${kindPart}`
  log(`${separator}\n${formatTimestamp()} ${tag} ${spanInfo}${meta}`)
})

spanFinishCh.subscribe((span) => {
  const name = span._name
  if (!match(name)) return
  const tags = span._spanContext?._tags || {}
  const error = tags.error
  let errorMsg = ''
  if (error) {
    let msg
    try {
      msg = error.message || (typeof error === 'string' ? error : error.name || 'error')
      // Truncate multiline errors to first line
      if (typeof msg === 'string' && msg.includes('\n')) {
        msg = msg.split('\n')[0] + '...'
      }
    } catch {
      msg = '[circular or unserializable error]'
    }
    errorMsg = colors.red(` error=${msg}`)
  }
  const meta = formatSpanMeta(tags)
  const spanIdPart = formatSpanId(span)
  const tag = colors.red('[SPAN:END]')
  log(`${formatTimestamp()} ${tag} ${colors.white(name)} ${spanIdPart}${errorMsg}${meta}\n${separator}`)
})

log(`${colors.green('[channel-debug]')} Filter: ${filter || '(all)'} | Verbose: ${verbose}`)
log(separator)

// ============================================================
// Mocha Test Output Highlighting
// ============================================================

const testMarker = noColor ? '>>> ' : '\x1b[33;1m>>> \x1b[0m'
const origStdoutWrite = process.stdout.write.bind(process.stdout)

process.stdout.write = function (chunk, encoding, callback) {
  const str = typeof chunk === 'string' ? chunk : chunk.toString()
  // Skip empty/whitespace-only
  if (!str.trim()) return origStdoutWrite(chunk, encoding, callback)
  // Add marker to all stdout content (mocha output)
  const lines = str.split('\n').map(l => l.trim() ? `${testMarker}${l}` : l).join('\n')
  return origStdoutWrite(lines, encoding, callback)
}

module.exports = {
  patchShimmer,
}
