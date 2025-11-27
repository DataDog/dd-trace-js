'use strict'

const shimmer = require('../../datadog-shimmer')
const { createWrapFetch } = require('./helpers/fetch')
const { addHook, tracingChannel } = require('./helpers/instrument')

const ch = tracingChannel('apm:electron:net:fetch')

addHook({ name: 'electron', versions: ['>=37.0.0'] }, electron => {
  // Electron exports a string in Node and an object in Electron.
  if (typeof electron === 'string') return electron

  shimmer.wrap(electron.net, 'fetch', createWrapFetch(globalThis.Request, ch))

  return electron
})
