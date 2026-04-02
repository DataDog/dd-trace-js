'use strict'

const { ipcRenderer } = require('electron/renderer')

// Receive the ping from the main process.
// The electron instrumentation wraps ipcRenderer.on so this creates an
// electron.renderer.receive span.
ipcRenderer.on('ping', () => {})
