// Initializes the tracer before the application uses electron. Bundlers still load external modules, such as
// electron, before bundled ones, so a bundled tracer patches the already loaded electron module.
import './tracer.mjs'

import http from 'node:http'
import path from 'node:path'

import { serve } from '@hono/node-server'
import { generateText } from 'ai'
import { app, BrowserWindow, ipcMain, net } from 'electron'
import { Hono } from 'hono'

import model from './model.mjs'

// The Datadog preload script calls ipcRenderer.sendSync(BRIDGE_CONFIG_CHANNEL) at load time, so this handler must be
// registered before any BrowserWindow loads.
ipcMain.on('datadog:bridge-config', event => {
  event.returnValue = null
})

// hono is an ES module package instrumented by hooks.
const hono = new Hono()
hono.get('/hono', context => context.text('ok'))
const honoServer = serve({ fetch: hono.fetch, hostname: '127.0.0.1', port: 0 })

let win

app.whenReady().then(() => {
  const appDirectory = app.getAppPath()
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(appDirectory, 'preload.js'),
    },
  })

  win.loadFile(path.join(appDirectory, 'index.html'))
  win.webContents.once('did-finish-load', () => process.send('ready'))

  process.on('message', ({ name, url }) => {
    switch (name) {
      case 'quit':
        return app.quit()
      case 'http':
        return net.fetch(url).catch(() => {})
      case 'ipc':
        return win.webContents.send('ping')
      case 'ai':
        return generateText({ model, prompt: 'Say ok', experimental_telemetry: { isEnabled: true } })
      case 'hono':
        return http.get(`http://127.0.0.1:${honoServer.address().port}/hono`, response => response.resume())
    }
  })
})
