'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const satisfies = require('../../../vendor/dist/semifies')
const {
  addHook,
  getHooks,
} = require('./helpers/instrument')
const { createWrapFetch } = require('./helpers/fetch')

/**
 * @typedef {Record<string | symbol, unknown> & {
 *   Dispatcher: typeof import('undici').Dispatcher,
 *   Request: Function,
 *   getGlobalDispatcher: typeof import('undici').getGlobalDispatcher,
 *   setGlobalDispatcher: typeof import('undici').setGlobalDispatcher,
 * }} UndiciModule
 * @typedef {{ dispatch: import('undici').Dispatcher['dispatch'] }} DispatcherLike
 * @typedef {(...args: unknown[]) => unknown} WrappedFunction
 */

const ch = tracingChannel('apm:undici:fetch')
const dispatchChannel = tracingChannel('orchestrion:undici:Client_dispatch')
const wrappedDispatchers = new WeakSet()

// Undici 5.0.x has a bug where fetch doesn't preserve AggregateError in the error cause chain
// Use native DC only for versions where error handling works correctly
const NATIVE_DC_VERSION = '>=4.7.0 <5.0.0 || >=5.1.0'

for (const hook of getHooks('undici')) {
  addHook(hook, passthrough)
}

addHook({
  name: 'undici',
  versions: ['^4.4.1', '5', '>=6.0.0'],
}, wrapUndici)

/**
 * @param {unknown} moduleExports
 * @param {string} version
 * @returns {unknown}
 */
function wrapUndici (moduleExports, version) {
  const undici = /** @type {UndiciModule} */ (moduleExports)

  if (satisfies(version, '>=4.7.0')) {
    wrapGlobalDispatcher(undici.getGlobalDispatcher(), undici.Dispatcher)
    shimmer.wrap(
      undici,
      'setGlobalDispatcher',
      setGlobalDispatcher => createWrapSetGlobalDispatcher(setGlobalDispatcher, undici.Dispatcher)
    )
  }

  // For versions with working native DC, let the plugin subscribe directly
  if (satisfies(version, NATIVE_DC_VERSION)) {
    return undici
  }

  // For older versions or those with buggy error handling, wrap fetch
  return shimmer.wrap(undici, 'fetch', createWrapFetch(undici.Request, ch))
}

/**
 * @param {DispatcherLike} dispatcher
 * @param {typeof import('undici').Dispatcher} Dispatcher
 */
function wrapGlobalDispatcher (dispatcher, Dispatcher) {
  if (!dispatcher || wrappedDispatchers.has(dispatcher)) return

  try {
    if (dispatcher instanceof Dispatcher || typeof dispatcher.dispatch !== 'function') return

    const wrapped = shimmer.wrap(dispatcher, 'dispatch', createWrapDispatch)
    if (wrapped === dispatcher) {
      wrappedDispatchers.add(dispatcher)
    }
  } catch (error) {
    log.debug('Unable to instrument the existing Undici global dispatcher: %s', error)
  }
}

/**
 * @param {Function} dispatch
 * @returns {WrappedFunction}
 */
function createWrapDispatch (dispatch) {
  /**
   * @param {import('undici').Dispatcher.DispatchOptions} options
   * @param {import('undici').Dispatcher.DispatchHandlers} handler
   */
  function wrappedDispatch (options, handler) {
    if (!dispatchChannel.start.hasSubscribers) return dispatch.call(this, options, handler)

    return dispatchChannel.traceSync(dispatch, { options, self: this }, this, options, handler)
  }
  return /** @type {WrappedFunction} */ (wrappedDispatch)
}

/**
 * @param {Function} setGlobalDispatcher
 * @param {typeof import('undici').Dispatcher} Dispatcher
 * @returns {WrappedFunction}
 */
function createWrapSetGlobalDispatcher (setGlobalDispatcher, Dispatcher) {
  /**
   * @param {DispatcherLike} dispatcher
   */
  function wrappedSetGlobalDispatcher (dispatcher) {
    wrapGlobalDispatcher(dispatcher, Dispatcher)
    return setGlobalDispatcher.call(this, dispatcher)
  }
  return /** @type {WrappedFunction} */ (wrappedSetGlobalDispatcher)
}

/**
 * @param {unknown} moduleExports
 * @returns {unknown}
 */
function passthrough (moduleExports) {
  return moduleExports
}
