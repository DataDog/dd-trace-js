'use strict'

const http = require('node:http')

class NitroTestSetup {
  constructor () {
    this.server = null
    this.port = null
    this.app = null
  }

  /**
   * @param {object} mod - h3 module from withVersions (has H3, toNodeHandler, etc.)
   */
  async setup (mod) {
    const { H3, toNodeHandler } = mod
    const { tracingPlugin } = require('h3/tracing')

    this.app = new H3()
    // Unit tests use CJS require('h3') via withVersions; CJS require of ESM is not
    // intercepted by iitm so the instrumentation's auto-registration cannot fire.
    // Register tracingPlugin explicitly here. Real Nitro/h3 ESM apps get it automatically
    // via the addHook callback in packages/datadog-instrumentations/src/nitro.js.
    this.app.register(tracingPlugin())
    this.app.get('/hello', () => ({ ok: true }))
    this.app.get('/users/:id', event => ({ id: event.context.params.id }))
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

  async tracingPluginParameterized () {
    await this._request('/users/42')
  }

  async tracingPluginError () {
    await this._request('/error')
  }

  async tracingPluginWithHeaders (headers) {
    await this._request('/hello', headers)
  }

  _request (path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        path,
        method: 'GET',
        headers,
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
