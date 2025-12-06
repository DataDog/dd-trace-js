'use strict'

const { contextBridge, ipcRenderer } = require('electron/renderer')

ipcRenderer.send('datadog:apm:full', !!globalThis._ddtrace)

if (globalThis.logger) {
  globalThis.logger.debug = (...args) => ipcRenderer.send('datadog:log', 'debug', ...args)
  globalThis.logger.info = (...args) => ipcRenderer.send('datadog:log', 'info', ...args)
  globalThis.logger.warn = (...args) => ipcRenderer.send('datadog:log', 'warn', ...args)
  globalThis.logger.error = (...args) => ipcRenderer.send('datadog:log', 'error', ...args)
}

contextBridge.exposeInMainWorld('electronAPI', {
  setTitle: title => ipcRenderer.sendSync('set-title', title)
})

const listener = () => {
  ipcRenderer.off('update-counter', listener)
}

ipcRenderer.on('update-counter', listener)
