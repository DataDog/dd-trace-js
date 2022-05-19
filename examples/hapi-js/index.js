'use strict'
const tracer = require('../..')

console.log('index before.init')

const myTracer = tracer.init({
  logInjection: true
})
console.log('index after tracer.init')

const Hapi = require('@hapi/hapi')
// manage logs
const Pino = require('hapi-pino')

const getResponse = [
  { string: 'string1', number: 1, boolean: true },
  { string: 'string2', number: 2, boolean: false }
]

async function start () {
  // Create a server with a host and port
  const server = Hapi.server({
    host: 'localhost',
    port: 3000,
    debug: false // disable Hapi debug console logging
  })

  console.log('index before server.ext') // #5
  await server.ext([
    {
      type: 'onPreStart',
      method: (server) => {
        // const reviewScope = myTracer.scope().active()
        console.log('inside onPreStart')
        return myTracer.trace('onPreStart', { tags: server.info }, () => server)
      }
    },
    {
      type: 'onRequest',
      method: (request, h) => {
        // const reviewScope = myTracer.scope().active()
        return myTracer.trace('onRequest', {}, () => h.continue)
      }
    }
  ])

  // Add the route
  server.route({
    method: 'GET',
    path: '/items',
    handler: async function (request, h) {
      return h.response(getResponse)
    }
  })
  //   const tmpDir = Path.join(__dirname, '.tmp_' + Date.now())
  //   const destination = join(tmpDir, 'output')

  await server.register({
    plugin: Pino,
    options: {
      logPayload: true,
      mergeHapiLogData: true,
      ignorePaths: ['/alive.txt', '/private'],
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          messageFormat: true,
          translateTime: true,
          singleLine: false
        }
      }
    }
  })

  await server.start()

  server.log(['info'], `Items endPoint running: ${server.info.uri}/items`)
  return server
}

start().catch(() => {
  process.exit(1)
})
