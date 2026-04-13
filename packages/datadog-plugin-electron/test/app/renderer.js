'use strict'

const { ipcRenderer } = require('electron/renderer')

ipcRenderer.on('datadog:test:bridge', () => {
  const bridge = window.DatadogEventBridge
  let sendSuccess = false

  try {
    bridge.send('test-payload')
    sendSuccess = true
  } catch (_e) {
    // sendSuccess stays false
  }

  ipcRenderer.send('datadog:test:bridge:result', {
    exists: !!bridge,
    capabilities: bridge?.getCapabilities(),
    privacyLevel: bridge?.getPrivacyLevel(),
    allowedHosts: bridge?.getAllowedWebViewHosts(),
    sendSuccess,
  })
})
