'use strict'

const { ipcRenderer } = require('electron/renderer')

if (globalThis.logger) {
  globalThis.logger.debug = (...args) => ipcRenderer.send('datadog:log', 'debug', ...args)
  globalThis.logger.info = (...args) => ipcRenderer.send('datadog:log', 'info', ...args)
  globalThis.logger.warn = (...args) => ipcRenderer.send('datadog:log', 'warn', ...args)
  globalThis.logger.error = (...args) => ipcRenderer.send('datadog:log', 'error', ...args)
}

function updateCounter () {
  ipcRenderer.off('update-counter', updateCounter)
}

ipcRenderer.on('update-counter', updateCounter)

ipcRenderer.on('datadog:test:send', () => {
  setImmediate(() => ipcRenderer.send('set-title', 'Test'))
})
