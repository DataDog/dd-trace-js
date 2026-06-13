'use strict'

// Loaded for side effects only (via --require or require()).
// Patches diagnostic channels, shimmer, rewriter, and span lifecycle for debug logging.

const { performance } = require('node:perf_hooks')
const { inspect } = require('node:util')

const dc = require('dc-polyfill')

// Config
const filter = process.env.DD_TEST_CHANNEL_FILTER || ''
const showData = process.env.DD_TEST_CHANNEL_SHOW_DATA === 'true'
const verbose = process.env.DD_TEST_CHANNEL_VERBOSE === 'true'
// `hasColors()` already accounts for NO_COLOR and FORCE_COLOR; the fallback
// only matters on Node versions where the method is unavailable.
const useColor = process.stderr.hasColors
  ? process.stderr.hasColors()
  : !(process.env.NO_COLOR || process.env.FORCE_COLOR === '0')
const startTime = performance.now()

// Colors via util.inspect.colors (disabled when not TTY or NO_COLOR is set)
const c = {}
for (const name of ['cyan', 'yellow', 'green', 'gray', 'blue', 'red', 'magenta', 'white']) {
  if (!useColor) { c[name] = s => s; continue }
  const [open, close] = inspect.colors[name]
  c[name] = s => `\x1b[${open}m${s}\x1b[${close}m`
}

const INDENT = '                    ' // 20 spaces to clear mocha indentation
const SEP = c.gray('────────────────────')

function log (msg) {
  process.stderr.write(msg.split('\n').map(line => INDENT + line).join('\n') + '\n')
}

function ts () {
  return c.gray(`[+${(performance.now() - startTime).toFixed(0)}ms]`)
}

// Filter matching with wildcard support (*foo*, foo*, *foo)
const filterRe = filter && new RegExp('^' + filter.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
const match = name => !filterRe || filterRe.test(name)

// Channel patching.
// Node.js swaps a channel's prototype from `Channel` to `ActiveChannel` once it has
// subscribers, so a patch on `Channel.prototype` alone never sees publishes/subscribes
// on active channels. We therefore log-and-passthrough on BOTH prototypes. Crucially we
// never wrap subscriber functions: the prototype swap makes wrapper identity unrecoverable
// on unsubscribe, which silently leaks subscribers and corrupts behaviour. Passthrough
// preserves subscriber identity exactly, so instrumentation semantics are untouched.

function safeStringify (msg) {
  try {
    return JSON.stringify(msg)
  } catch {
    return String(msg)
  }
}

function patchChannelProto (proto, active) {
  const { subscribe, unsubscribe, publish } = proto

  proto.subscribe = function (fn) {
    if (match(this.name)) {
      log(`${ts()} ${c.blue('[SUB]')} ${c.cyan(this.name)} ${c.gray('← ' + (fn.name || 'anon'))}`)
    }
    return subscribe.apply(this, arguments)
  }

  proto.unsubscribe = function (fn) {
    if (match(this.name)) {
      log(`${ts()} ${c.gray('[UNSUB]')} ${c.cyan(this.name)} ${c.gray('← ' + (fn.name || 'anon'))}`)
    }
    return unsubscribe.apply(this, arguments)
  }

  proto.publish = function (msg) {
    if (match(this.name)) {
      let out = `${ts()} ${c.yellow('[PUB]')} ${c.cyan(this.name)}${active ? '' : c.red(' (no subscribers)')}`
      if (showData && msg) out += ` ${c.gray(safeStringify(msg).slice(0, 80))}`
      log(out)
    }
    return publish.apply(this, arguments)
  }
}

// Capture the `ActiveChannel` prototype (only reachable via an activated channel) before
// patching, so the probe's own subscribe/unsubscribe stay unlogged.
const probe = dc.channel('dd-trace:debug:active-channel-probe')
const probeFn = () => {}
probe.subscribe(probeFn)
const activeChannelProto = Object.getPrototypeOf(probe)
probe.unsubscribe(probeFn)

patchChannelProto(dc.Channel.prototype, false)
// Guard: if a runtime ever stops swapping prototypes on activation, the probe's prototype
// is just `Channel.prototype` and patching it again would double-deliver every publish.
if (activeChannelProto !== dc.Channel.prototype) {
  patchChannelProto(activeChannelProto, true)
}

// TracingChannel patching
const origTracingChannel = dc.tracingChannel
dc.tracingChannel = function (name) {
  const tc = origTracingChannel.call(this, name)
  for (const m of ['traceSync', 'tracePromise', 'traceCallback']) {
    const fn = tc[m]
    if (fn) {
      tc[m] = function (...args) {
        if (!match(name)) return fn.apply(this, args)
        const t = performance.now()
        const r = fn.apply(this, args)
        const dur = (performance.now() - t).toFixed(2) + 'ms'
        log(`${ts()} ${c.magenta(`[${m.toUpperCase()}]`)} ${c.cyan(name)} ${c.gray(dur)}`)
        return r
      }
    }
  }
  return tc
}

// Shimmer patching
const shimmer = require('../../../datadog-shimmer')
const origWrap = shimmer.wrap
shimmer.wrap = function (obj, method, wrapper) {
  const name = inspect(obj, { depth: -1 })
  if (match(method) || match(name)) log(`${ts()} ${c.magenta('[WRAP]')} ${c.yellow(name)}.${c.cyan(method)}`)
  return origWrap.apply(this, arguments)
}
const origMass = shimmer.massWrap
shimmer.massWrap = function (obj, methods, wrapper) {
  const name = inspect(obj, { depth: -1 })
  for (const m of methods) {
    if (match(m) || match(name)) log(`${ts()} ${c.magenta('[WRAP]')} ${c.yellow(name)}.${c.cyan(m)}`)
  }
  return origMass.apply(this, arguments)
}

// Rewriter patching - log when code gets rewritten by orchestrion
const instrumentations = require('../../../datadog-instrumentations/src/helpers/rewriter/instrumentations')
const rewriter = require('../../../datadog-instrumentations/src/helpers/rewriter')
const origRewrite = rewriter.rewrite
rewriter.rewrite = function (content, filename, format) {
  const result = origRewrite.call(this, content, filename, format)
  if (result !== content) {
    const file = filename.replace('file://', '')
    for (const { functionQuery = {}, module: mod, channelName } of instrumentations) {
      if (!file.endsWith(`${mod.name}/${mod.filePath}`)) continue
      const { className, methodName, kind } = functionQuery
      const target = className ? `${className}.${methodName}` : methodName || channelName
      if (match(mod.name) || match(target) || match(channelName)) {
        const op = kind === 'Async' ? 'tracePromise' : kind === 'Callback' ? 'traceCallback' : 'traceSync'
        log(`${SEP}\n${ts()} ${c.magenta('[REWRITE]')} ${c.cyan(mod.name)} ${c.yellow(target)} ${c.blue(op)}`)
      }
    }
  }
  return result
}

// Span lifecycle logging
const SKIP_TAGS = new Set(['runtime-id', 'process_id', 'service.name', 'resource.name', 'span.kind', 'error'])

function spanId (span) {
  const id = span?._spanContext?._spanId
  return id ? c.gray(`[${id.toString(16).padStart(16, '0').slice(-8)}]`) : ''
}

function spanMeta (tags) {
  if (!verbose || !tags) return ''
  const items = []
  for (const [k, v] of Object.entries(tags)) {
    if (SKIP_TAGS.has(k) || k.startsWith('_dd') || v == null) continue
    let val = v !== null && typeof v === 'object' ? JSON.stringify(v) : v
    if (typeof val === 'string' && val.length > 50) val = val.slice(0, 47) + '...'
    items.push(`${k}=${val}`)
  }
  if (!items.length) return ''
  const lines = []
  for (let i = 0; i < items.length; i += 3) lines.push('    ' + items.slice(i, i + 3).join('  '))
  return '\n' + c.gray(lines.join('\n'))
}

dc.channel('dd-trace:span:start').subscribe(({ span, fields }) => {
  const name = fields.operationName
  if (!match(name)) return
  const tags = span?._spanContext?.getTags() || fields.tags || {}
  const svc = tags['service.name'] || ''
  const res = tags['resource.name']
  const kind = tags['span.kind']
  const info = `${c.white(name)} ${spanId(span)} ${c.cyan(svc)}${res ? c.blue(' ' + res) : ''}`
  log(`${SEP}\n${ts()} ${c.green('[SPAN:START]')} ${info}${kind ? c.magenta(' ' + kind) : ''}${spanMeta(tags)}`)
})

dc.channel('dd-trace:span:finish').subscribe(span => {
  const name = span._name
  if (!match(name)) return
  const tags = span._spanContext?.getTags() || {}
  let err = ''
  if (tags.error) {
    let msg = tags.error.message || tags.error.name || 'error'
    if (msg.includes('\n')) msg = msg.split('\n')[0] + '...'
    err = c.red(` error=${msg}`)
  }
  log(`${ts()} ${c.red('[SPAN:END]')} ${c.white(name)} ${spanId(span)}${err}${spanMeta(tags)}\n${SEP}`)
})

log(`${c.green('[channel-debug]')} Filter: ${filter || '(all)'} | Verbose: ${verbose}`)
log(SEP)

// Prefix mocha output to distinguish from debug logs
const marker = useColor ? '\x1b[33;1m>>> \x1b[0m' : '>>> '
const origWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk, enc, cb) {
  const str = typeof chunk === 'string' ? chunk : chunk.toString()
  if (!str.trim()) return origWrite(chunk, enc, cb)
  return origWrite(str.split('\n').map(l => l.trim() ? marker + l : l).join('\n'), enc, cb)
}

// This module is loaded purely for its patching side effects (via --require or
// require()) and intentionally exports nothing.
module.exports = {}
