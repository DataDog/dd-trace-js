'use strict'

const { addHook } = require('./helpers/instrument')
const tracer = require('../../dd-trace')
const shimmer = require('../../datadog-shimmer')

const { TracerProvider } = tracer
const provider = new TracerProvider()
provider.register()

const { channel } = require('dc-polyfill')
const toolCreationChannel = channel('dd-trace:vercel-ai:tool')

const TRACED_FUNCTIONS = {
  generateText: wrapWithTracer,
  streamText: wrapWithTracer,
  generateObject: wrapWithTracer,
  streamObject: wrapWithTracer,
  embed: wrapWithTracer,
  embedMany: wrapWithTracer,
  tool: wrapTool
}

function wrapWithTracer (fn) {
  return function () {
    const options = arguments[0]
    if (options.experimental_telemetry != null) return fn.apply(this, arguments)

    options.experimental_telemetry = {
      isEnabled: true,
      // TODO(sabrenner): need to figure out how a user can configure this tracer
      // maybe we advise they do this manually?
      tracer: provider.getTracer()
    }

    return fn.apply(this, arguments)
  }
}

function wrapTool (tool) {
  return function () {
    const args = arguments[0]
    toolCreationChannel.publish(args)

    return tool.apply(this, arguments)
  }
}

addHook({
  name: 'ai',
  versions: ['>=4.0.0'],
}, exports => {
  // the exports from this package are not configurable
  // to return wrapped functions with the tracer provided above,
  // we need to copy the exports
  const wrappedExports = {}

  for (const [fnName, patchingFn] of Object.entries(TRACED_FUNCTIONS)) {
    const original = exports[fnName]
    wrappedExports[fnName] = shimmer.wrapFunction(original, patchingFn)
  }

  Object.getOwnPropertyNames(exports).forEach(prop => {
    if (!Object.keys(TRACED_FUNCTIONS).includes(prop)) {
      wrappedExports[prop] = exports[prop]
    }
  })

  return wrappedExports
})
