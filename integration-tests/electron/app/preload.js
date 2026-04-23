'use strict'

const { ipcRenderer } = require('electron/renderer')

// Receive the ping from the main process.
// The electron instrumentation wraps ipcRenderer.on so this creates an
// electron.renderer.receive span.
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
