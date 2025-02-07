'use strict'

import childProcess from 'node:child_process'
import express from 'express'
import Module from 'node:module'
import './worker.mjs'

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/cmdi-vulnerable', (req, res) => {
  childProcess.execSync(`ls ${req.query.args}`)

  res.end()
})

app.use('/more', (await import('./more.mjs')).default)

app.listen(port, () => {
  process.send({ port })
})

Module.register('./custom-noop-hooks.mjs', {
  parentURL: import.meta.url
})
