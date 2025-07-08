'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')
const childProcess = require('child_process')

const app = express()

app.get('/shi/execFileSync', async (req, res) => {
  childProcess.execFileSync('ls', [req.query.dir], { shell: true })

  res.end('OK')
})

app.get('/shi/execFileSync/out-of-express-scope', async (req, res) => {
  process.nextTick(() => {
    childProcess.execFileSync('ls', [req.query.dir], { shell: true })

    res.end('OK')
  })
})

app.get('/shi/execSync', async (req, res) => {
  childProcess.execSync('ls', [req.query.dir])

  res.end('OK')
})

app.get('/shi/execSync/out-of-express-scope', async (req, res) => {
  process.nextTick(() => {
    childProcess.execSync('ls', [req.query.dir])

    res.end('OK')
  })
})

app.get('/cmdi/execFileSync', async (req, res) => {
  childProcess.execFileSync('sh', ['-c', req.query.command])

  res.end('OK')
})

app.get('/cmdi/execFileSync/out-of-express-scope', async (req, res) => {
  process.nextTick(() => {
    childProcess.execFileSync('sh', ['-c', req.query.command])

    res.end('OK')
  })
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
