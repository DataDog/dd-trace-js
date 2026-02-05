'use strict'

// Prevent double-patching when loaded multiple times
if (globalThis._ddChannelDebugPatched) return
globalThis._ddChannelDebugPatched = true

const dc = require('node:diagnostics_channel')
const { performance } = require('node:perf_hooks')
const Hook = require('../../src/ritm')

// Config
const filter = process.env.TEST_CHANNEL_FILTER || ''
const showData = process.env.TEST_CHANNEL_SHOW_DATA === 'true'
const verbose = process.env.TEST_CHANNEL_VERBOSE === 'true'
const noColor = (!process.stderr.isTTY && process.env.FORCE_COLOR !== '1') || process.env.NO_COLOR
const startTime = performance.now()

// Colors (disabled when not TTY)
const id = s => s
const c = noColor
  ? { cyan: id, yellow: id, green: id, gray: id, blue: id, red: id, magenta: id, white: id }
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

// Channel patching
// Node.js uses a native fast path when channels have subscribers, bypassing JS publish().
// We wrap subscribers to log publishes since the prototype patch only catches no-subscriber cases.
const { subscribe, unsubscribe, publish } = dc.Channel.prototype
const wrappers = new WeakMap()

function wrapSub (fn, name) {
  const wrapped = function (msg) {
    if (match(name)) {
      let out = `${ts()} ${c.yellow('[PUB]')} ${c.cyan(name)}`
      if (showData && msg) out += ` ${c.gray(JSON.stringify(msg).slice(0, 80))}`
      log(out)
    }
    return fn.apply(this, arguments)
  }
  wrappers.set(fn, wrapped)
  return wrapped
}

dc.Channel.prototype.subscribe = function (fn) {
  if (match(this.name)) {
    log(`${ts()} ${c.blue('[SUB]')} ${c.cyan(this.name)} ${c.gray('← ' + (fn.name || 'anon'))}`)
  }
  return subscribe.call(this, wrapSub(fn, this.name))
}

dc.Channel.prototype.unsubscribe = function (fn) {
  if (match(this.name)) {
    log(`${ts()} ${c.gray('[UNSUB]')} ${c.cyan(this.name)} ${c.gray('← ' + (fn.name || 'anon'))}`)
  }
  return unsubscribe.call(this, wrappers.get(fn) || fn)
}

dc.Channel.prototype.publish = function (msg) {
  if (match(this.name)) {
    let out = `${ts()} ${c.yellow('[PUB]')} ${c.cyan(this.name)}${c.red(' (no subscribers)')}`
    if (showData && msg) out += ` ${c.gray(JSON.stringify(msg).slice(0, 80))}`
    log(out)
  }
  return publish.call(this, msg)
}

// Module-level dc.subscribe/unsubscribe (Node 18.7+)
/* eslint-disable n/no-unsupported-features/node-builtins */
if (dc.subscribe) {
  const orig = dc.subscribe
  dc.subscribe = function (name, fn) {
    if (match(name)) {
      log(`${ts()} ${c.blue('[SUB]')} ${c.cyan(name)} ${c.gray('← ' + (fn.name || 'anon'))}`)
    }
    return orig.call(this, name, wrapSub(fn, name))
  }
}
if (dc.unsubscribe) {
  const orig = dc.unsubscribe
  dc.unsubscribe = function (name, fn) {
    if (match(name)) {
      log(`${ts()} ${c.gray('[UNSUB]')} ${c.cyan(name)} ${c.gray('← ' + (fn.name || 'anon'))}`)
    }
    return orig.call(this, name, wrappers.get(fn) || fn)
  }
}
/* eslint-enable n/no-unsupported-features/node-builtins */

// TracingChannel patching (dc-polyfill)
Hook(['dc-polyfill'], exp => {
  const orig = exp.tracingChannel
  exp.tracingChannel = function (name) {
    const tc = orig.call(this, name)
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
  return exp
})

// Shimmer patching
Hook(['shimmer', 'datadog-shimmer'], exp => {
  const origWrap = exp.wrap
  exp.wrap = function (obj, method, wrapper) {
    const name = obj?.constructor?.name || typeof obj
    if (match(method) || match(name)) log(`${ts()} ${c.magenta('[WRAP]')} ${c.yellow(name)}.${c.cyan(method)}`)
    return origWrap.call(this, obj, method, wrapper)
  }
  if (exp.massWrap) {
    const origMass = exp.massWrap
    exp.massWrap = function (obj, methods, wrapper) {
      const name = obj?.constructor?.name || typeof obj
      for (const m of methods) {
        if (match(m) || match(name)) log(`${ts()} ${c.magenta('[WRAP]')} ${c.yellow(name)}.${c.cyan(m)}`)
      }
      return origMass.call(this, obj, methods, wrapper)
    }
  }
  return exp
})

// Rewriter patching - log when code gets rewritten by orchestrion
let instrumentations = []
try { instrumentations = require('../../../datadog-instrumentations/src/helpers/rewriter/instrumentations') } catch {}

try {
  const rewriter = require('../../../datadog-instrumentations/src/helpers/rewriter')
  const orig = rewriter.rewrite
  rewriter.rewrite = function (content, filename, format) {
    const result = orig.call(this, content, filename, format)
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
} catch {}

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
    let val = typeof v === 'object' ? JSON.stringify(v) : v
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
  const tags = span?._spanContext?._tags || fields.tags || {}
  const svc = tags['service.name'] || ''
  const res = tags['resource.name']
  const kind = tags['span.kind']
  const info = `${c.white(name)} ${spanId(span)} ${c.cyan(svc)}${res ? c.blue(' ' + res) : ''}`
  log(`${SEP}\n${ts()} ${c.green('[SPAN:START]')} ${info}${kind ? c.magenta(' ' + kind) : ''}${spanMeta(tags)}`)
})

dc.channel('dd-trace:span:finish').subscribe(span => {
  const name = span._name
  if (!match(name)) return
  const tags = span._spanContext?._tags || {}
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
const marker = noColor ? '>>> ' : '\x1b[33;1m>>> \x1b[0m'
const origWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk, enc, cb) {
  const str = typeof chunk === 'string' ? chunk : chunk.toString()
  if (!str.trim()) return origWrite(chunk, enc, cb)
  return origWrite(str.split('\n').map(l => l.trim() ? marker + l : l).join('\n'), enc, cb)
}

module.exports = {}
