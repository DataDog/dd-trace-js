'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const logChannel = channel('apm:paperplane:log')
const handleChannel = channel('apm:paperplane:request:handle')
const routeChannel = channel('apm:paperplane:request:route')

const nodeMajor = Number(process.versions.node.split('.')[0])
const name = 'paperplane'
const versions = nodeMajor <= 12 ? ['>=2.3.2'] : nodeMajor <= 14 ? ['>=3.1.1'] : []

const wrapRoute = handler => req => {
  const { original, route } = req

  if (routeChannel.hasSubscribers) {
    routeChannel.publish({ req: original, route })
  }

  return handler(req)
}

const wrapLogger = logger => record => {
  const event = { message: record }

  logChannel.publish(event)

  return logger(event.message)
}

const wrapMount = mount => opts => {
  const handler = mount(opts)

  return function (req, res) {
    handleChannel.publish(req)

    return handler.apply(this, arguments)
  }
}

const wrapRoutes = routes => handlers => {
  const traced = {}

  for (const route in handlers) {
    traced[route] = wrapRoute(handlers[route])
  }

  return routes(traced)
}

addHook({ name, versions, file: 'lib/logger.js' }, exports => {
  shimmer.wrap(exports, 'logger', wrapLogger)

  return exports
})

addHook({ name, versions, file: 'lib/mount.js' }, exports => {
  shimmer.wrap(exports, 'mount', wrapMount)

  return exports
})

addHook({ name, versions, file: 'lib/routes.js' }, exports => {
  shimmer.wrap(exports, 'routes', wrapRoutes)

  return exports
})

if (nodeMajor <= 12) {
  addHook({ name, versions: ['2.3.0 - 2.3.1'] }, paperplane => {
    shimmer.wrap(paperplane, 'mount', wrapMount)
    shimmer.wrap(paperplane, 'routes', wrapRoutes)

    return paperplane
  })
}
