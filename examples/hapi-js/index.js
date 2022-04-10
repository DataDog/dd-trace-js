'use strict'
const tracer = require('../..')

tracer.init({
  logInjection: true
}).use('hapi', {})

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

  // Add the route
  server.route({
    method: 'GET',
    path: '/items',
    handler: async function (request, h) {
    // test sonicBoob library works
    // const sonic = new SonicBoom({
    //   dest: './pino-logs/node_trace.1.log',
    //   append: true,
    //   mkdir: true
    // });
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
  await server.ext([
    {
      type: 'onPreStart',
      method: (request) => {
        tracer.scope().activate(null, () => {})
      }
    }
  ])
  await server.start()

  server.log(['info'], `Items endPoint running: ${server.info.uri}/items`)
  return server
}

start().catch(() => {
  process.exit(1)
})
