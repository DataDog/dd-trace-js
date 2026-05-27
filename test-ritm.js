'use strict'

const { channel } = require('dc-polyfill')
const loadChannel = channel('dd-trace:instrumentation:load')

loadChannel.subscribe((event) => {
  console.log(`[loadChannel] FIRED: name=${event.name}`)
})

// Force ritm/iitm to register
require('./packages/datadog-instrumentations')

console.log('--- About to require claude-agent-sdk ---')
try {
  const mod = require('@anthropic-ai/claude-agent-sdk')
  console.log(`Loaded module keys: ${Object.keys(mod).slice(0, 5).join(',')}`)
} catch (e) {
  console.log(`Error: ${e.message}`)
}

console.log('--- Test complete ---')
