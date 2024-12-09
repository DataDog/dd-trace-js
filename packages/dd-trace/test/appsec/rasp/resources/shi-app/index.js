'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 1
})

const express = require('express')
const childProcess = require('child_process')

const app = express()
const port = process.env.APP_PORT || 3000

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
  childProcess.execFileSync('sh', ['-c', req.query.dir])

  res.end('OK')
})

app.get('/cmdi/execFileSync/out-of-express-scope', async (req, res) => {
  process.nextTick(() => {
    childProcess.execFileSync('sh', ['-c', req.query.dir])

    res.end('OK')
  })
})

app.get('/cmdi/spawnSync', async (req, res) => {
  childProcess.spawnSync('sh', ['-c', req.query.dir])

  res.end('OK')
})

app.get('/cmdi/spawnSync/out-of-express-scope', async (req, res) => {
  process.nextTick(() => {
    childProcess.spawnSync('sh', ['-c', req.query.dir])

    res.end('OK')
  })
})

app.listen(port, () => {
  process.send({ port })
})
