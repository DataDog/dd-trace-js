'use strict'

const express = require('express')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const EventEmitter = require('events')
const { fork } = require('child_process')
const http = require('http')
const assert = require('assert')

class FakeAgent extends EventEmitter {
  constructor (port = 0) {
    super()
    const agent = express()
    agent.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    agent.use((req, res) => {
      if (req.body.length === 0) return res.status(200).send()
      this.emit('message', {
        headers: req.headers,
        payload: msgpack.decode(req.body, { codec })
      })
    })
    this.server = http.createServer(agent).listen(port, () => {
      this.port = this.server.address().port
      this.emit('listening', this.port)
    })
  }

  listeningPort () {
    return new Promise((resolve) => {
      this.on('listening', resolve)
    })
  }

  close () {
    this.server.close()
  }

  gotGoodPayload (options = {}) {
    const hostHeader = options.hostHeader || `127.0.0.1:${this.port}`
    return new Promise((resolve, reject) => {
      this.on('message', ({ headers, payload }) => {
        try {
          assert.strictEqual(headers.host, hostHeader)
          assert.strictEqual(payload.length, 1)
          assert.strictEqual(payload[0].length, 1)
          assert.strictEqual(payload[0][0].name, 'http.request')
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  }
}

function spawnAndGetURL (filename, options = {}) {
  const proc = fork(filename, options)
  return new Promise((resolve, reject) => {
    proc.on('message', ({ port }) => {
      proc.url = `http://localhost:${port}`
      resolve(proc)
    }).on('error', reject)
  })
}

async function curl (url) {
  if (typeof url === 'object') {
    if (url.then) {
      return curl(await url)
    }
    url = url.url
  }
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const bufs = []
      res.on('data', d => bufs.push(d))
      res.on('end', () => {
        res.body = Buffer.concat(bufs).toString('utf8')
        resolve(res)
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

module.exports = {
  FakeAgent,
  spawnAndGetURL,
  curl
}
