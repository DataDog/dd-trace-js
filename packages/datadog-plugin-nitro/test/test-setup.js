'use strict'

const http = require('node:http')

class NitroTestSetup {
  constructor () {
    this.server = null
    this.port = null
    this.app = null
  }

  /**
   * @param {{ mod: object, versionMod: { get: (id?: string) => object } }} meta - test meta from
   *   createIntegrationTestSuite. `meta.mod` is the resolved h3 module; `meta.versionMod.get(id)`
   *   loads any submodule pinned to the same version (avoids NODE_PATH leakage).
   */
  async setup (meta) {
    const { H3, toNodeHandler } = meta.mod
    const { tracingPlugin } = meta.versionMod.get('h3/tracing')

    this.app = new H3()
    // Unit tests use CJS require('h3') via withVersions; CJS require of ESM is not
    // intercepted by iitm so the instrumentation's auto-registration cannot fire.
    // Register tracingPlugin explicitly here. Real Nitro/h3 ESM apps get it automatically
    // via the addHook callback in packages/datadog-instrumentations/src/nitro.js.
    this.app.register(tracingPlugin())
    // Middleware is also wrapped by h3's tracingPlugin (type='middleware'). The plugin must
    // filter to type='route' so this middleware does not produce its own span per request.
    this.app.use(() => {})
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
    return this._request('/hello')
  }

  async tracingPluginParameterized () {
    return this._request('/users/42')
  }

  async tracingPluginError () {
    return this._request('/error')
  }

  async tracingPluginWithHeaders (headers) {
    return this._request('/hello', headers)
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
