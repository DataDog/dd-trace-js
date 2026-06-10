'use strict'

// eslint-disable-next-line n/no-missing-require
const { contextBridge, ipcRenderer } = require('electron')

const BRIDGE_CHANNEL = 'datadog:bridge-send'
const CONFIG_CHANNEL = 'datadog:bridge-config'

// Privacy levels matching @datadog/browser-core DefaultPrivacyLevel
const MASK = 'mask'

const config = ipcRenderer.sendSync(CONFIG_CHANNEL)

const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? MASK
const configuredHosts = config?.allowedWebViewHosts ?? []
// eslint-disable-next-line no-undef
const allowedHosts = [...new Set([location.hostname, ...configuredHosts])]

const bridge = {
  getCapabilities () {
    return '[]'
  },
  getPrivacyLevel () {
    return defaultPrivacyLevel
  },
  getAllowedWebViewHosts () {
    return JSON.stringify(allowedHosts)
  },
  send (msg) {
    ipcRenderer.send(BRIDGE_CHANNEL, msg)
  },
}

// Support both contextIsolation enabled (default) and disabled

window.DatadogEventBridge = bridge

try {
  contextBridge.exposeInMainWorld('DatadogEventBridge', bridge)
} catch {
  // exposeInMainWorld throws when contextIsolation is disabled
}
