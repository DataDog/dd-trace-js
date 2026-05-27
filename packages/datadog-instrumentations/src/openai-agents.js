'use strict'

const { channel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

// `WeakSet` keyed by module exports — replaces the underscored
// `mod._datadogPatched` flag while keeping dedupe semantics. Mods are kept
// alive by `require.cache` anyway, so this doesn't add lifetime to anything.
const patchedMods = new WeakSet()

// Plugin subscribes to this and registers its TracingProcessor when
// `@openai/agents-core` loads. Publishing from here keeps this file free of
// any cross-package import from the plugin.
//
// Normal init: `register.js` runs `loadChannel.publish({ name })`
// immediately before invoking the addHook callback, which synchronously
// constructs the plugin and lets its constructor subscribe — so the
// publish below lands on a live subscriber.
//
// Late-construct path (e.g. unrelated test loads `@openai/agents-core`
// before our plugin is constructed): the addHook callback fires first and
// the publish has no subscriber. To survive that we also push the mod into
// `loadedAgentsCoreMods` and the plugin drains the set on subscribe. Set
// holds at most one entry per process (agents-core is a singleton dep) and
// the mod is kept alive by `require.cache` anyway — no extra lifetime.
const agentsCoreLoadedCh = channel('apm:openai-agents:agents-core:loaded')

// Plugin subscribes here to keep track of the OpenAI-compatible client's
// baseURL — used to resolve `model_provider` (openai / azure_openai /
// deepseek / unknown). Sabrenner's review suggested moving this wrap to
// orchestrion + a TracingPlugin subscriber, but orchestrion's YAML config
// only exposes `tracePromise` / `traceSync` operators, and
// `OpenAIResponsesModel.getStreamedResponse` is an async generator —
// neither operator wraps async generators correctly today. Until
// orchestrion grows an async-iterator operator at the YAML layer, shimmer
// is the smaller surface; we keep the subscriber/channel half of the
// suggestion so the wrap stays decoupled from the plugin module.
const responseClientCh = channel('apm:openai-agents:response:client')

// Hook @openai/agents (not @openai/agents-core) because @openai/agents/dist/index.mjs
// calls setDefaultOpenAITracingExporter() at module load time, which calls
// setTraceProcessors([defaultProcessor()]) and wipes any processor registered earlier.
// @openai/agents re-exports addTraceProcessor from @openai/agents-core, so mod here
// has everything we need and fires after the reset.
addHook({ name: '@openai/agents', versions: ['>=0.7.0'] }, (mod) => {
  if (patchedMods.has(mod)) return mod
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
  shimmer.wrap(proto, 'getStreamedResponse', wrapResponseMethod)
  return mod
})
