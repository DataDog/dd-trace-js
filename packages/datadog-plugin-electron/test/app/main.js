'use strict'

/* eslint-disable no-console */

const { join } = require('path')
const { BrowserWindow, app, ipcMain, net } = require('electron/main')

const CONFIG_CHANNEL = 'datadog:bridge-config'
const BRIDGE_CHANNEL = 'datadog:bridge-send'

ipcMain.on(CONFIG_CHANNEL, event => {
  event.returnValue = null
})

app.on('ready', () => {
  process.send('ready')
  process.on('message', msg => {
    try {
      switch (msg.name) {
        case 'quit': return app.quit()
        case 'fetch': return onFetch(msg)
        case 'request': return onRequest(msg)
        case 'send': return onSend(msg)
        case 'receive': return onReceive(msg)
        case 'bridge': return onBridge()
      }
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.on('datadog:log', (_event, level, ...args) => {
    console.log('datadog:log')
    console[level](...args)
  })
})

function onFetch ({ url }) {
  net.fetch(url)
}

function onRequest ({ options }) {
  const req = net.request(options)

  req.on('error', e => console.error(e))
  req.on('response', res => {
    res.on('data', () => {})
  })

  req.end()
}

function onSend () {
  loadWindow(win => {
    win.webContents.send('update-counter', 1)
  })
}

function onReceive () {
  const listener = () => {
    ipcMain.off('set-title', listener)
  }

  ipcMain.on('set-title', listener)

  loadWindow(win => {
    win.webContents.send('datadog:test:send')
  })
}

function onBridge () {
  ipcMain.once(BRIDGE_CHANNEL, (_event, msg) => {
    process.send({ name: 'bridge-send', msg })
  })

  ipcMain.once('datadog:test:bridge:result', (_event, result) => {
    process.send({ name: 'bridge', result })
  })

  loadWindow(win => {
    win.webContents.send('datadog:test:bridge')
  })
}

function loadWindow (onShow) {
  const mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      preload: join(__dirname, 'preload.js'),
    },
  })

  ipcMain.on('datadog:test:log', (_event, ...args) => {
    console.log(...args)
  })

  mainWindow.loadFile('index.html')
  mainWindow.once('ready-to-show', () => onShow?.(mainWindow))
}
