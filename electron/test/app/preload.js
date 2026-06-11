'use strict'

// eslint-disable-next-line n/no-missing-require
const { ipcRenderer } = require('electron/renderer')

// Receive ping from the main process.
// The instrumentation wraps ipcRenderer.on so this creates a renderer.receive span.
ipcRenderer.on('ping', () => {})

// Check that DatadogEventBridge was injected by the Datadog preload script.
ipcRenderer.on('check-bridge', () => {
  const bridge = window.DatadogEventBridge
  let sendSuccess = false

  try {
    bridge.send('test-payload')
    sendSuccess = true
  } catch (_e) {
    // sendSuccess stays false
  }

  ipcRenderer.send('bridge-result', {
    exists: !!bridge,
    capabilities: bridge?.getCapabilities(),
    privacyLevel: bridge?.getPrivacyLevel(),
    allowedHosts: bridge?.getAllowedWebViewHosts(),
    sendSuccess,
  })
})
