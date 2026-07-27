'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

// `WeakSet` keyed by module exports — replaces the underscored
// `mod._datadogPatched` flag while keeping dedupe semantics. Mods are kept
// alive by `require.cache` anyway, so this doesn't add lifetime to anything.
const patchedMods = new WeakSet()
const modelBaseURLs = new WeakMap()
const chatCompletionsModelConstructorCh =
  tracingChannel('orchestrion:@openai/agents-openai:OpenAIChatCompletionsModel_constructor')

/**
 * Capture the client base URL before the SDK stores the client in a #private field.
 *
 * @param {{ arguments?: [{ baseURL?: string }], self?: object }} ctx
 */
function captureChatCompletionsModelBaseURL (ctx) {
  const baseURL = ctx.arguments?.[0]?.baseURL
  if (ctx.self && typeof baseURL === 'string') modelBaseURLs.set(ctx.self, baseURL)
}

chatCompletionsModelConstructorCh.end.subscribe(captureChatCompletionsModelBaseURL)

for (const hook of getHooks('@openai/agents-openai')) {
  addHook(hook, moduleExports => moduleExports)
}

// Plugin subscribes to this and registers its TracingProcessor when
// `@openai/agents` loads. Publishing from here keeps this file free of
// any cross-package import from the plugin.
const agentsCoreLoadedCh = channel('apm:openai-agents:agents-core:loaded')

// Plugin uses addBind on this channel so that legacyStorage.run(store, fn) wraps
// the model call — including async iterator advancement for streaming responses.
// This ensures the active dd-trace span is visible to the openai plugin when it
// creates its openai.request span, correctly parenting it under the agent span.
const modelStartCh = channel('apm:openai-agents:model:start')

// Tool.invoke runs inside agents-core's public function-span context. Bind the
// corresponding dd-trace tool span around that public invocation boundary so
// spans created by user tool code inherit it.
const toolStartCh = channel('apm:openai-agents:tool:start')

// Reference to the loaded @openai/agents module, captured in the first hook
// so that wrapResponseMethod can call getCurrentSpan() without an additional
// require (and without triggering n/no-missing-require on agents-core internals).
let agentsMod

// @openai/agents >=0.8.0 moved addTraceProcessor / getCurrentSpan out of the
// top-level re-exports.  The new public surface uses getGlobalTraceProvider():
//   provider.registerProcessor(processor)  (replaces addTraceProcessor)
//   provider.getCurrentSpan()              (replaces getCurrentSpan)
// Both APIs are tried so this file works across the full supported version range.
// The plugin subscriber (index.js) handles processor registration via the channel.
function getCurrentSpan () {
  if (typeof agentsMod?.getCurrentSpan === 'function') {
    return agentsMod.getCurrentSpan()
  }
  if (typeof agentsMod?.getGlobalTraceProvider === 'function') {
    return agentsMod.getGlobalTraceProvider().getCurrentSpan()
  }
}

function getCurrentSpanId () {
  return getCurrentSpan()?.spanId
}

addHook({ name: '@openai/agents', versions: ['>=0.7.0'] }, (mod) => {
  if (patchedMods.has(mod)) return mod
  if (typeof mod?.addTraceProcessor !== 'function' && typeof mod?.getGlobalTraceProvider !== 'function') return mod
  patchedMods.add(mod)
  agentsMod = mod
  if (typeof mod.tool === 'function') {
    shimmer.wrap(mod, 'tool', wrapToolFactory, { replaceGetter: true })
  }
  agentsCoreLoadedCh.publish({ mod })
  return mod
})

function wrapToolFactory (original) {
  return function (...args) {
    const tool = original.apply(this, args)
    if (typeof tool?.invoke === 'function') {
      shimmer.wrap(tool, 'invoke', wrapToolInvoke)
    }
    return tool
  }
}

function wrapToolInvoke (original) {
  return function (...args) {
    const agentsCoreSpan = getCurrentSpan()
    return toolStartCh.runStores({ agentsCoreSpan }, () => original.apply(this, args))
  }
}

function wrapResponseMethod (original) {
  return function (...args) {
    const agentsCoreSpanId = getCurrentSpanId()
    const baseURL = getClientBaseURL(this)
    return modelStartCh.runStores({ agentsCoreSpanId, baseURL }, () => original.apply(this, args))
  }
}

function wrapStreamedResponseMethod (original) {
  return function (...args) {
    const agentsCoreSpanId = getCurrentSpanId()
    const baseURL = getClientBaseURL(this)
    const context = { agentsCoreSpanId, baseURL }
    const iterator = modelStartCh.runStores(context, () => original.apply(this, args))
    return wrapAsyncIterator(iterator, context)
  }
}

function getClientBaseURL (model) {
  return model?.client?.baseURL ?? model?._client?.baseURL ?? modelBaseURLs.get(model)
}

function wrapAsyncIterator (iterator, context) {
  if (!iterator || typeof iterator !== 'object') return iterator

  return {
    next () {
      return modelStartCh.runStores(context, () => iterator.next.apply(iterator, arguments))
    },
    throw () {
      if (typeof iterator.throw !== 'function') return Promise.reject(arguments[0])
      return modelStartCh.runStores(context, () => iterator.throw.apply(iterator, arguments))
    },
    return () {
      if (typeof iterator.return !== 'function') return Promise.resolve({ done: true, value: arguments[0] })
      return modelStartCh.runStores(context, () => iterator.return.apply(iterator, arguments))
    },
    [Symbol.asyncIterator] () {
      return this
    },
  }
}

addHook({ name: '@openai/agents-openai', versions: ['>=0.7.0'] }, (mod) => {
  if (patchedMods.has(mod)) return mod
  const responseProto = mod?.OpenAIResponsesModel?.prototype
  const chatCompletionsProto = mod?.OpenAIChatCompletionsModel?.prototype
  if (!responseProto && !chatCompletionsProto) return mod

  patchedMods.add(mod)
  for (const proto of [responseProto, chatCompletionsProto]) {
    if (typeof proto?.getResponse === 'function') {
      shimmer.wrap(proto, 'getResponse', wrapResponseMethod)
    }
    if (typeof proto?.getStreamedResponse === 'function') {
      shimmer.wrap(proto, 'getStreamedResponse', wrapStreamedResponseMethod)
    }
  }
  return mod
})
