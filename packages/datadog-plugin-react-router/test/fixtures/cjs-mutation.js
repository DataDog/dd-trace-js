'use strict'

const path = require('node:path')

if (process.env.INSTRUMENTED) {
  require('../../../..').init()
}

const versionKey = process.argv[2]
const versionModule = require(`../../../../versions/react-router@${versionKey}`)
const cjs = path.basename(versionModule.getPath()) === 'index.js'
const { createRequestHandler } = versionModule.get()
const key = versionKey === '7.9.5' ? 'unstable_instrumentations' : 'instrumentations'
/** @type {Record<string, unknown>} */
const entryModule = {
  [key]: [],
  default: () => new Response('ok'),
}
const build = {
  basename: '/',
  future: { v8_middleware: false },
  ssr: true,
  prerender: [],
  routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
  routes: { root: { id: 'root', path: '/', module: { default () {} } } },
  assets: { version: 'test', routes: {} },
  entry: { module: entryModule },
}

const handleRequest = createRequestHandler(build, 'test')
let calls = 0
entryModule[key] = [{
  /**
   * @param {{ instrument: (hooks: {
   *   request: (run: () => Promise<unknown>) => Promise<unknown>
   * }) => void }} handler
   */
  handler (handler) {
    handler.instrument({
      /** @param {() => Promise<unknown>} run */
      async request (run) {
        calls++
        return run()
      },
    })
  },
}]

handleRequest(new Request('http://localhost/')).then(async response => {
  process.stdout.write(JSON.stringify({ cjs, calls, status: response.status, body: await response.text() }), () => {
    // eslint-disable-next-line n/no-process-exit -- The child owns the tracer and has flushed its result.
    process.exit(0)
  })
}).catch(error => {
  process.stderr.write(error.stack)
  process.exitCode = 1
})
