'use strict'

// dd-trace is bundled inside the binary alongside the app source.
// No external path or NODE_OPTIONS injection needed.
require('dd-trace').init({
  service: 'electron-integration-test',
  flushInterval: 0,
  plugins: false,
}).use('electron', true)

const path = require('path')
const { app, BrowserWindow, net } = require('electron/main')

let win

app.whenReady().then(() => {
  // Create the window immediately so it is ready before any test command arrives.
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))

  // Only signal ready after the renderer has finished loading so that any
  // subsequent IPC message sent by the test will find a live webContents.
  win.webContents.once('did-finish-load', () => process.send('ready'))

  process.on('message', ({ name, url }) => {
    switch (name) {
      case 'quit':
        return app.quit()

      // Trigger an outgoing HTTP request so we get an http.request span.
      case 'http':
        return net.fetch(url).catch(() => {})

      // Send an IPC message from the main process to the renderer so we get
      // an electron.main.send span.
      case 'ipc':
        return win.webContents.send('ping')
    }
  })
})
