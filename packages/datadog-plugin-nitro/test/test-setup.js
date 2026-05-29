'use strict'

const http = require('node:http')

/**
 * Test setup for the nitro / h3 integration.
 *
 * Spins up a real h3 v2 app (the HTTP framework Nitro v3 uses under the
 * hood) and serves it via Node's built-in http module by wrapping the
 * app with h3's `toNodeHandler`. This avoids depending on srvx's
 * `serve` helper which has additional runtime detection and is harder
 * to drive deterministically inside mocha.
 *
 * The `withVersions` helper extends `NODE_PATH` to include the
 * version-specific node_modules tree before this setup runs, so a
 * top-level `require('h3')` resolves to the version under test.
 */
class NitroTestSetup {
  constructor () {
    this.server = null
    this.port = null
    this.app = null
  }

  async setup () {
    const { H3, toNodeHandler } = require('h3')
    const { tracingPlugin } = require('h3/tracing')

    this.app = new H3()
    this.app.register(tracingPlugin())
    this.app.get('/hello', () => ({ ok: true }))
    this.app.get('/error', () => {
      throw new Error('nitro test boom')
    })

    const nodeHandler = toNodeHandler(this.app)

    await new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        Promise.resolve(nodeHandler(req, res)).catch(err => {
          if (!res.headersSent) {
            res.statusCode = 500
            res.end(String(err?.message || err))
          }
        })
      })
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve()
      })
    })
  }

  async teardown () {
    if (this.server) {
      await new Promise(resolve => this.server.close(() => resolve()))
      this.server = null
    }
    this.app = null
    this.port = null
  }

  async tracingPlugin () {
    await this._request('/hello')
  }

  async tracingPluginError () {
    await this._request('/error')
  }

  _request (path) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        path,
        method: 'GET',
      }, res => {
        res.resume()
        res.once('end', () => resolve({ statusCode: res.statusCode }))
      })
      req.once('error', reject)
      req.end()
    })
  }
}

module.exports = NitroTestSetup
