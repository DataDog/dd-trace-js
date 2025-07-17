import childProcess from 'node:child_process'
import express from 'express'
import Module from 'node:module'
import './worker.mjs'

const app = express()

app.get('/cmdi-vulnerable', (req, res) => {
  childProcess.execSync(`ls ${req.query.args}`)

  res.end()
})

app.use('/more', (await import('./more.mjs')).default)

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})

Module.register('./custom-noop-hooks.mjs', {
  parentURL: import.meta.url
})
