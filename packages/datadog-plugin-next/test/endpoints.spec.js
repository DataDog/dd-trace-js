'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
require('../../datadog-instrumentations/src/next')

const routeAddedChannel = dc.channel('apm:next:route:added')

/**
 * Builds the exports of `dist/server/load-components.js`, which expose `loadComponents` through a getter.
 *
 * @param {(options: object) => Promise<object>} loadComponents
 */
function instrumentLoadComponents (loadComponents) {
  const loadComponentsExports = {}
  Object.defineProperty(loadComponentsExports, 'loadComponents', { enumerable: true, get: () => loadComponents })
  const { hook } = instrumentations.next.find(hook => hook.file === 'dist/server/load-components.js')
  // The getter is not configurable, so the hook returns replacement exports.
  return hook(loadComponentsExports)
}

/**
 * @param {object} runtime
 */
function instrumentAppRouteRuntime (runtime) {
  const { hook } = instrumentations.next.find(hook => hook.filePattern?.includes('app-route['))
  hook(runtime, '16.0.0')
}

describe('Next.js endpoint collection hooks', () => {
  let onRoute

  beforeEach(() => {
    onRoute = sinon.spy()
    routeAddedChannel.subscribe(onRoute)
  })

  afterEach(() => {
    if (routeAddedChannel.hasSubscribers) routeAddedChannel.unsubscribe(onRoute)
  })

  describe('loadComponents', () => {
    it('is hooked from Next.js 15', () => {
      const hooks = instrumentations.next.filter(hook => hook.file === 'dist/server/load-components.js')

      assert.deepStrictEqual(hooks.map(hook => hook.versions), [['>=15']])
    })

    // The published pages are process-wide, so each test loads its own pages.
    /**
     * @param {object | undefined} components
     * @param {object} [options]
     */
    async function load (components, options = { page: components?.page }) {
      const loadComponents = sinon.stub().resolves(components)
      const instrumented = instrumentLoadComponents(loadComponents)
      const loaded = await instrumented.loadComponents(options)
      assert.strictEqual(loaded, components)
      sinon.assert.calledOnceWithExactly(loadComponents, options)
    }

    it('publishes the route facts of a loaded page', async () => {
      const definition = { kind: 'PAGES', page: '/hello/[name]', pathname: '/hello/[name]' }
      await load({ page: '/hello/[name]', isAppPath: false, routeModule: { definition } })
      await load({ page: '/static', isAppPath: false, ComponentMod: '<html></html>' })

      assert.deepStrictEqual(onRoute.getCalls().map(call => call.args[0]), [
        { page: '/hello/[name]', isAppPath: false, kind: 'PAGES', pathname: '/hello/[name]', userland: undefined },
        { page: '/static', isAppPath: false, kind: undefined, pathname: undefined, userland: undefined },
      ])
    })

    it('publishes the loaded module of an app route handler', async () => {
      const userland = { GET () {} }
      const definition = { kind: 'APP_ROUTE', page: '/api/items/route', pathname: '/api/items' }
      await load({ page: '/api/items/route', isAppPath: true, routeModule: { definition, userland } })

      sinon.assert.calledOnceWithExactly(onRoute, {
        page: '/api/items/route',
        isAppPath: true,
        kind: 'APP_ROUTE',
        pathname: '/api/items',
        userland,
      }, routeAddedChannel.name)
    })

    it('does not run a lazy userland getter', async () => {
      const getUserland = sinon.spy(() => ({ GET () {} }))
      const routeModule = Object.create({ get userland () { return getUserland() } })
      routeModule.definition = { kind: 'APP_ROUTE', page: '/api/lazy/route', pathname: '/api/lazy' }

      await load({ page: '/api/lazy/route', isAppPath: true, routeModule })

      sinon.assert.notCalled(getUserland)
      assert.strictEqual(onRoute.firstCall.args[0].userland, undefined)
    })

    it('publishes each page once without chaining later loads', async () => {
      const components = { page: '/once', isAppPath: false }
      await load(components)

      const later = Promise.resolve(components)
      const instrumented = instrumentLoadComponents(() => later)
      assert.strictEqual(instrumented.loadComponents({ page: '/once' }), later)
      sinon.assert.calledOnce(onRoute)
    })

    it('does not publish from a development server', async () => {
      await load({ page: '/dev', isAppPath: false }, { page: '/dev', isDev: true })

      sinon.assert.notCalled(onRoute)
    })

    it('does not chain the load without subscribers', () => {
      routeAddedChannel.unsubscribe(onRoute)
      const components = Promise.resolve({ page: '/quiet', isAppPath: false })
      const instrumented = instrumentLoadComponents(() => components)

      assert.strictEqual(instrumented.loadComponents({ page: '/quiet' }), components)
    })

    it('preserves the rejection of the original load and retries the page later', async () => {
      const error = new Error('missing page')
      const instrumented = instrumentLoadComponents(() => Promise.reject(error))

      await assert.rejects(instrumented.loadComponents({ page: '/retry' }), error)
      sinon.assert.notCalled(onRoute)

      await load({ page: '/retry', isAppPath: false })
      sinon.assert.calledOnce(onRoute)
    })
  })

  describe('_onUserlandLoaded', () => {
    let AppRouteRouteModule

    beforeEach(() => {
      AppRouteRouteModule = class {
        constructor () {
          this.definition = { kind: 'APP_ROUTE', page: '/api/items/route', pathname: '/api/items' }
        }

        _onUserlandLoaded (userland) {
          this.loaded = userland
          return 'loaded'
        }
      }
      instrumentAppRouteRuntime({ AppRouteRouteModule })
    })

    it('publishes the module Next.js loaded for the route handler', () => {
      const routeModule = new AppRouteRouteModule()
      const userland = { GET () {}, POST () {} }

      assert.strictEqual(routeModule._onUserlandLoaded(userland), 'loaded')
      assert.strictEqual(routeModule.loaded, userland)

      sinon.assert.calledOnceWithExactly(onRoute, {
        isAppPath: true,
        kind: 'APP_ROUTE',
        pathname: '/api/items',
        userland,
      }, routeAddedChannel.name)
    })

    it('does not publish from a development server', () => {
      const routeModule = new AppRouteRouteModule()
      routeModule.isDev = true

      assert.strictEqual(routeModule._onUserlandLoaded({ GET () {} }), 'loaded')

      sinon.assert.notCalled(onRoute)
    })

    it('does not publish without subscribers', () => {
      routeAddedChannel.unsubscribe(onRoute)
      const routeModule = new AppRouteRouteModule()
      const getDefinition = sinon.spy(() => ({}))
      Object.defineProperty(routeModule, 'definition', { get: getDefinition })

      assert.strictEqual(routeModule._onUserlandLoaded({ GET () {} }), 'loaded')

      sinon.assert.notCalled(getDefinition)
    })

    it('preserves the error of the original method', () => {
      const error = new Error('invalid route config')
      class ThrowingRouteModule {
        _onUserlandLoaded () {
          throw error
        }
      }
      instrumentAppRouteRuntime({ AppRouteRouteModule: ThrowingRouteModule })

      assert.throws(() => new ThrowingRouteModule()._onUserlandLoaded({ GET () {} }), error)
      sinon.assert.notCalled(onRoute)
    })
  })
})
