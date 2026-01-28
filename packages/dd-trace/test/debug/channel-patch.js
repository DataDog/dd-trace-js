'use strict'


if (globalThis._ddChannelDebugPatched) return
globalThis._ddChannelDebugPatched = true

const dc = require('node:diagnostics_channel')
const { performance } = require('node:perf_hooks')
const Module = require('node:module')

const Hook = require('../../src/ritm')

const filter = process.env.DD_CHANNEL_FILTER || ''
const showData = process.env.DD_CHANNEL_SHOW_DATA === 'true'
const verbose = process.env.DD_CHANNEL_VERBOSE === 'true'
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
      white: identity
    }
  : {
      cyan: s => `\x1b[36m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      green: s => `\x1b[32m${s}\x1b[0m`,
      gray: s => `\x1b[90m${s}\x1b[0m`,
      blue: s => `\x1b[34m${s}\x1b[0m`,
      red: s => `\x1b[31m${s}\x1b[0m`,
      magenta: s => `\x1b[35m${s}\x1b[0m`,
      white: s => `\x1b[37m${s}\x1b[0m`
    }

const indent = '                    ' // 20 spaces - well past mocha's indentation

/**
 * Writes a line to stderr synchronously to prevent interleaving with stdout.
 * @param {string} line - The line to write (can contain newlines)
 */
function log (line) {
  const indented = line.split('\n').map(l => indent + l).join('\n')
  process.stderr.write(indented + '\n')
}

/**
 * Checks if a channel name matches the configured filter pattern.
 * Supports wildcard patterns: `*foo*` (contains), `*foo` (ends with), `foo*` (starts with).
 * @param {string} name - The channel name to check
 * @returns {boolean} True if the name matches the filter or no filter is set
 */
function match (name) {
  if (!filter) return true
  const startsWild = filter.startsWith('*')
  const endsWild = filter.endsWith('*')
  const pattern = filter.slice(startsWild ? 1 : 0, endsWild ? -1 : undefined)
  if (startsWild && endsWild) return name.includes(pattern)
  if (startsWild) return name.endsWith(pattern)
  if (endsWild) return name.startsWith(pattern)
  return name.includes(filter)
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

const { subscribe, publish, runStores } = dc.Channel.prototype

dc.Channel.prototype.subscribe = function (fn) {
  if (match(this.name)) {
    log(`${formatTimestamp()} ${colors.blue('[SUB]')} ${colors.cyan(this.name)} ${colors.gray(`← ${fn.name || 'anon'}`)}`)
  }
  return subscribe.call(this, fn)
}

dc.Channel.prototype.publish = function (msg) {
  if (match(this.name)) {
    let line = `${formatTimestamp()} ${colors.yellow('[PUB]')} ${colors.cyan(this.name)}`
    if (!this.hasSubscribers) line += colors.red(' (no subscribers)')
    if (showData && msg) line += ` ${colors.gray(JSON.stringify(msg).slice(0, 80))}`
    log(line)
  }
  return publish.call(this, msg)
}

dc.Channel.prototype.runStores = function (ctx, fn, thisArg, ...args) {
  if (!match(this.name)) return runStores.call(this, ctx, fn, thisArg, ...args)
  const start = performance.now()
  const result = runStores.call(this, ctx, fn, thisArg, ...args)
  log(`${formatTimestamp()} ${colors.green('[RUN]')} ${colors.cyan(this.name)} ${formatDuration(start)}`)
  return result
}

// ============================================================
// TracingChannel Patching (dc-polyfill)
// ============================================================

Hook(['dc-polyfill'], exports => {
  if (exports._channelDebugPatched) return exports
  exports._channelDebugPatched = true
  const orig = exports.tracingChannel
  exports.tracingChannel = function (name) {
    const tracingChannel = orig.call(this, name)
    if (tracingChannel._channelDebugPatched) return tracingChannel
    tracingChannel._channelDebugPatched = true
    for (const method of ['traceSync', 'tracePromise', 'traceCallback']) {
      const fn = tracingChannel[method]
      if (fn) {
        tracingChannel[method] = function (...args) {
          if (!match(name)) return fn.apply(this, args)
          const start = performance.now()
          const result = fn.apply(this, args)
          log(`${formatTimestamp()} ${colors.magenta(`[${method.toUpperCase()}]`)} ${colors.cyan(name)} ${formatDuration(start)}`)
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
            log(`${separator}\n${formatTimestamp()} ${colors.magenta('[REWRITE]')} ${colors.cyan(mod.name)} ${colors.yellow(target)} ${colors.blue(operator)} ${colors.gray(mod.filePath)}`)
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
// Span Lifecycle Patching
// ============================================================

/**
 * Patches the dd-trace module to enable span lifecycle logging.
 * @param {object} exports - The dd-trace module exports
 * @returns {object} The patched exports
 */
function patchDdTrace (exports) {
  if (exports._channelDebugPatched) return exports
  exports._channelDebugPatched = true

  if (exports._tracer) {
    patchTracer(exports)
  }

  const origInit = exports.init
  if (origInit) {
    exports.init = function (...args) {
      const tracer = origInit.apply(this, args)
      patchTracer(tracer || exports)
      return tracer
    }
  }
  return exports
}

Hook(['dd-trace'], patchDdTrace)

const skipTags = new Set([
  'runtime-id', 'process_id',
  // Already displayed on main span line
  'service.name', 'resource.name', 'span.kind', 'error'
])

/**
 * Formats span tags for display, filtering out common/internal tags.
 * Groups tags on indented lines (3 per line) for readability.
 * Only outputs tags when DD_CHANNEL_VERBOSE=true.
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

/**
 * Logs span start event with service, resource, kind, and metadata.
 * @param {string} name - The span name
 * @param {object} span - The span object
 * @param {object} options - The span options containing tags
 */
function logSpanStart (name, span, options) {
  const tags = span?._spanContext?._tags || options.tags || {}
  const service = tags['service.name'] || ''
  const resource = tags['resource.name'] || ''
  const kind = tags['span.kind'] || ''
  const meta = formatSpanMeta(tags)
  const resourcePart = resource ? colors.blue(` ${resource}`) : ''
  const kindPart = kind ? colors.magenta(` ${kind}`) : ''
  log(`${separator}\n${formatTimestamp()} ${colors.green('[SPAN:START]')} ${colors.white(name)} ${colors.cyan(service)}${resourcePart}${kindPart}${meta}`)
}

/**
 * Patches the startSpan method on a target object to enable span logging.
 * @param {object} target - The object containing startSpan method
 * @param {object} [bindTarget] - Optional object to bind startSpan to
 */
function patchStartSpan (target, bindTarget) {
  if (!target.startSpan || target._startSpanPatched) return
  target._startSpanPatched = true
  const origStartSpan = target.startSpan.bind(bindTarget || target)
  target.startSpan = function (name, options = {}) {
    const span = origStartSpan(name, options)
    if (match(name)) logSpanStart(name, span, options)
    patchSpanFinish(span, name)
    return span
  }
}

/**
 * Patches the tracer's startSpan method and its internal tracer if present.
 * @param {object} tracer - The tracer object to patch
 */
function patchTracer (tracer) {
  if (!tracer) return
  patchStartSpan(tracer, tracer)
  if (tracer._tracer) {
    patchStartSpan(tracer._tracer)
  }
}

/**
 * Patches a span's finish method to log span end events.
 * @param {object} span - The span object to patch
 * @param {string} name - The span name for logging
 */
function patchSpanFinish (span, name) {
  if (!span || span._finishPatched) return
  span._finishPatched = true
  const origFinish = span.finish.bind(span)
  span.finish = function (finishTime) {
    if (match(name)) {
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
      log(`${formatTimestamp()} ${colors.yellow('[SPAN:END]')} ${colors.white(name)}${errorMsg}${meta}\n${separator}`)
    }
    return origFinish(finishTime)
  }
}

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
  patchTracer,
  patchShimmer
}
