import '../../plugin/tracer.mjs'

import { app } from 'electron'

import { startServer } from '../../plugin/app.mjs'

app.whenReady().then(() => {
  startServer()
})
