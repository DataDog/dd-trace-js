'use strict'

const nock = require('nock')
const semver = require('semver')

const net = require('net')
const url = require('url')
const http = require('http')

const mocks = new Set()

class NetMock {
  constructor (theUrl, opts = {}) {
    this.opts = opts
    this.origConnect = net.connect
    theUrl = url.parse(theUrl)
    net.connect = (port, hostname) => {
      if (Number(port) === Number(theUrl.port) && hostname === theUrl.hostname) {
        port = this.mockServer.address().port
        hostname = 'localhost'
      }
      return this.origConnect(port, hostname)
    }
  }

  put (path, body) {
    this.putPath = path
    if (body) {
      this.putBody = typeof body === 'string' ? body : JSON.stringify(body)
    }
    return this
  }

  socketDelay (delay) {
    this.socketDelay = delay
    return this
  }

  reply (status, body) {
    if (!this.putPath) {
      throw new Error('you must call `put` first')
    }
    this.mockServer = http.createServer((req, res) => {
      const respond = (status, body) => {
        res.statusCode = status
        res.end(body)
        this.destroy()
      }
      if (req.url !== this.putPath || req.method !== 'PUT') {
        respond(404)
        return
      }
      if (this.opts.reqheaders) {
        for (const headerName in this.opts.reqheaders) {
          if (req.headers[headerName] !== this.opts.reqheaders[headerName]) {
            respond(404)
          }
        }
      }
      let data = ''
      req.on('data', d => {
        data += d
      })
      req.on('end', () => {
        if (this.putBody && data !== this.putBody) {
          respond(404)
          return
        }

        if (this.socketDelay) {
          setTimeout(respond, this.socketDelay, status, body)
        } else {
          respond(status, body)
        }
      })
    })
    this.mockServer.listen(0)
    mocks.add(this)
  }

  destroy () {
    net.connect = this.origConnect
    this.mockServer.close()
    mocks.delete(this)
  }
}

function mock (theUrl, opts) {
  return new NetMock(theUrl, opts)
}

mock.cleanAll = () => {
  mocks.forEach(m => m.destroy())
}

// these two are for nock compat, but have no real need with this implementation
mock.disableNetConnect = () => {}
mock.enableNetConnect = () => {}
mock.isNetMock = true

const supportsUndici = semver.satisfies(process.versions.node, '^10.16.0 || ^12.3.0 || ^14.0.0')

module.exports = function getMock (useUndici) {
  return supportsUndici && useUndici ? mock : nock
}
