'use strict'

const dc = require('dc-polyfill')

dc.channel('dd-trace:instrumentation:load').subscribe(({ name }) => {
  if (name !== '@genkit-ai/core') return

  const Plugin = require('../../packages/dd-trace/src/plugins')['@genkit-ai/core']
  Plugin.prefix = 'tracing:orchestrion:@genkit-ai/core:runInNewSpan'
})
