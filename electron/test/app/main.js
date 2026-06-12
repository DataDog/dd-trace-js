'use strict'

// dd-trace must be initialized before electron is required
// eslint-disable-next-line n/no-missing-require
require('dd-trace').init({
  service: 'electron-test',
  flushInterval: 0,
  plugins: false,
  experimental: { exporter: 'electron' },
})

// Auto-instrumentation: requiring this module patches electron in-place
require('../../src/index')

const { channel } = require('dc-polyfill')
const path = require('path')
// eslint-disable-next-line n/no-missing-require
const { app, BrowserWindow, ipcMain, net } = require('electron/main')

// Forward spans to the test process via IPC.
channel('datadog:apm:electron:export').subscribe(traces => {
  process.send({ name: 'traces', payload: traces })
})

const BRIDGE_CONFIG_CHANNEL = 'datadog:bridge-config'

ipcMain.on(BRIDGE_CONFIG_CHANNEL, event => {
  event.returnValue = null
})

let win

app.whenReady().then(() => {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))

  win.webContents.once('did-finish-load', () => process.send('ready'))

  process.on('message', ({ name, url }) => {
    switch (name) {
      case 'quit':
        return app.quit()

      case 'http':
        return net.fetch(url).catch(() => {})

      case 'ipc':
        return win.webContents.send('ping')

      case 'bridge':
        ipcMain.once('bridge-result', (_event, result) => {
          process.send({ name: 'bridge-result', result })
        })
        return win.webContents.send('check-bridge')
    }
  })
})
