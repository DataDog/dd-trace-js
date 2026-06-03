'use strict'

const { channel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

// `WeakSet` keyed by module exports — replaces the underscored
// `mod._datadogPatched` flag while keeping dedupe semantics. Mods are kept
// alive by `require.cache` anyway, so this doesn't add lifetime to anything.
const patchedMods = new WeakSet()

// Plugin subscribes to this and registers its TracingProcessor when
// `@openai/agents` loads. Publishing from here keeps this file free of
// any cross-package import from the plugin.
const agentsCoreLoadedCh = channel('apm:openai-agents:agents-core:loaded')

// Plugin subscribes here to keep track of the OpenAI-compatible client's
// baseURL — used to resolve `model_provider` (openai / azure_openai /
// deepseek / unknown). Only wraps `getResponse`; `getStreamedResponse` is
// handled by the orchestrion traceAsyncIterator rewriter (see
// helpers/rewriter/instrumentations/openai-agents.js).
const responseClientCh = channel('apm:openai-agents:response:client')

addHook({ name: '@openai/agents', versions: ['>=0.7.0'] }, (mod) => {
  if (patchedMods.has(mod)) return mod
  if (typeof mod?.addTraceProcessor !== 'function') return mod
  patchedMods.add(mod)
  agentsCoreLoadedCh.publish({ mod })
  return mod
})

function wrapResponseMethod (original) {
  return function (...args) {
    const baseURL = this?.client?.baseURL
    if (baseURL) responseClientCh.publish({ baseURL })
    return original.apply(this, args)
  }
}

addHook({ name: '@openai/agents-openai', versions: ['>=0.7.0'] }, (mod) => {
  if (patchedMods.has(mod)) return mod
  const proto = mod?.OpenAIResponsesModel?.prototype
  if (!proto) return mod

  patchedMods.add(mod)
  shimmer.wrap(proto, 'getResponse', wrapResponseMethod)
  return mod
})
