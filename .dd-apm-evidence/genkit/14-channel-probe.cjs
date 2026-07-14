'use strict'

const dc = require('dc-polyfill')

const loadChannel = dc.channel('dd-trace:instrumentation:load')
const expectedPrefix = 'tracing:orchestrion:@genkit-ai/core:runInNewSpan'
const configuredPrefix = 'orchestrion:@genkit-ai/core:runInNewSpan'
const events = ['start', 'end', 'asyncStart', 'asyncEnd', 'error']
const counts = {}

loadChannel.subscribe(({ name }) => {
  if (name !== '@genkit-ai/core') return

  process._rawDebug(JSON.stringify({
    probe: 'instrumentation-load',
    name,
    loadSubscriberCount: loadChannel._subscribers?.length,
    loadSubscriberNames: loadChannel._subscribers?.map(subscriber => subscriber.name),
  }))

  queueMicrotask(() => {
    const manager = global._ddtrace?._pluginManager
    const plugins = require('../../packages/dd-trace/src/plugins')
    const dependencyPlugin = plugins['@genkit-ai/core']
    const publicPlugin = plugins.genkit
    process._rawDebug(JSON.stringify({
      probe: 'post-load-subscribers',
      expectedStart: dc.channel(`${expectedPrefix}:start`).hasSubscribers,
      configuredStart: dc.channel(`${configuredPrefix}:start`).hasSubscribers,
      hasTracer: Boolean(global._ddtrace),
      instantiatedPlugins: manager ? Object.keys(manager._pluginsByName) : [],
      configuredPlugins: manager ? Object.keys(manager._configsByName) : [],
      dependencyPlugin: dependencyPlugin && { id: dependencyPlugin.id, type: typeof dependencyPlugin },
      publicPlugin: publicPlugin && { id: publicPlugin.id, type: typeof publicPlugin },
      genkitEnabledEnvironment: process.env.DD_TRACE_GENKIT_ENABLED,
      managerConfigured: Boolean(manager?._tracerConfig),
    }))

    for (const prefix of [expectedPrefix, configuredPrefix]) {
      for (const event of events) {
        const name = `${prefix}:${event}`
        counts[name] = 0
        dc.channel(name).subscribe(() => {
          counts[name]++
        })
      }
    }
  })
})

process.on('exit', () => {
  process._rawDebug(JSON.stringify({ probe: 'event-counts', counts }))
})
