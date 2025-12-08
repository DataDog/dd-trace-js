'use strict'

/* eslint-disable no-console */

const { BrowserWindow, app, ipcMain, net } = require('electron/main')
const { join } = require('path')

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

function loadWindow (onShow) {
  const mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      preload: join(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile('index.html')
  mainWindow.once('ready-to-show', () => onShow?.(mainWindow))
}
