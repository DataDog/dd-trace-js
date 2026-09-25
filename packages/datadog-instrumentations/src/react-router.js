'use strict'

const { addHook, channel, getHooks } = require('./helpers/instrument')

const deriveStartChannel = channel('tracing:orchestrion:react-router:derive:start')
const loaderStartChannel = channel('apm:react-router:loader:start')
const actionStartChannel = channel('apm:react-router:action:start')

/**
 * @typedef {{ pattern?: string, unstable_pattern?: string }} RouteHandlerInfo
 * @typedef {object} HandlerContext
 * @property {string} routeId
 * @property {string} [pattern]
 * @property {(result: unknown, rejected: boolean) => void} [complete]
 * @typedef {(callHandler: () => Promise<unknown>, info: RouteHandlerInfo) => Promise<unknown>} HandlerHook
 * @typedef {{ loader: HandlerHook, action: HandlerHook }} RouteHooks
 * @typedef {{ id: string, instrument: (hooks: RouteHooks) => void }} InstrumentableRoute
 * @typedef {{ instrumentations?: object[], unstable_instrumentations?: object[] }} EntryModule
 * @typedef {{ module?: EntryModule }} Entry
 * @typedef {{ entry?: Entry }} ServerBuild
 */

/**
 * @param {() => Promise<unknown>} callHandler
 * @param {RouteHandlerInfo} info
 * @param {string} routeId
 * @param {import('node:diagnostics_channel').Channel} startChannel
 */
function callRouteHandler (callHandler, info, routeId, startChannel) {
  if (!startChannel.hasSubscribers) return callHandler()

  /** @type {HandlerContext} */
  const context = {
    routeId,
    pattern: info?.pattern ?? info?.unstable_pattern,
    complete: undefined,
  }
  const result = startChannel.runStores(context, callHandler)
  const complete = context.complete
  if (!complete) return result

  return result.then(
    value => {
      complete(value, false)
      return value
    },
    error => {
      complete(error, true)
      throw error
    }
  )
}

const datadogInstrumentation = {
  /** @param {InstrumentableRoute} route */
  route (route) {
    const routeId = route.id
    route.instrument({
      /**
       * @param {() => Promise<unknown>} callHandler
       * @param {RouteHandlerInfo} info
       */
      loader (callHandler, info) {
        return callRouteHandler(callHandler, info, routeId, loaderStartChannel)
      },
      /**
       * @param {() => Promise<unknown>} callHandler
       * @param {RouteHandlerInfo} info
       */
      action (callHandler, info) {
        return callRouteHandler(callHandler, info, routeId, actionStartChannel)
      },
    })
  },
}

/** @param {ServerBuild} build */
function injectInstrumentation (build) {
  const entry = build?.entry
  const entryModule = entry?.module
  if (!entryModule || typeof entryModule !== 'object') return build

  const stable = entryModule.instrumentations
  const unstable = entryModule.unstable_instrumentations
  return {
    ...build,
    entry: {
      ...entry,
      module: {
        ...entryModule,
        instrumentations: Array.isArray(stable) ? [datadogInstrumentation, ...stable] : [datadogInstrumentation],
        unstable_instrumentations: Array.isArray(unstable)
          ? [datadogInstrumentation, ...unstable]
          : [datadogInstrumentation],
      },
    },
  }
}

/** @param {unknown} message */
function onDeriveStart (message) {
  const context = /** @type {{ arguments: ServerBuild[] }} */ (message)
  context.arguments[0] = injectInstrumentation(context.arguments[0])
}

deriveStartChannel.subscribe(onDeriveStart)

/** @param {unknown} exports */
function preserveExports (exports) {
  return exports
}

for (const hook of getHooks('react-router').values()) {
  addHook(hook, preserveExports)
}
