'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')

describe('next instrumentation', () => {
  let hooks
  let events

  beforeEach(() => {
    hooks = []
    events = []

    loadNextInstrumentation()
  })

  function loadNextInstrumentation () {
    const channels = new Map()
    const channel = name => {
      if (!channels.has(name)) {
        channels.set(name, {
          hasSubscribers: true,
          publish: message => events.push({ name, message }),
          runStores: (message, fn) => {
            events.push({ name, message })
            return fn()
          },
        })
      }
      return channels.get(name)
    }

    proxyquire('../src/next', {
      '../../datadog-shimmer': {
        wrap: (target, property, wrap) => {
          target[property] = wrap(target[property])
        },
      },
      './helpers/instrument': {
        channel,
        addHook: (options, hook) => {
          hooks.push({ options, hook })
        },
      },
    })
  }

  function instrumentAppRouteRuntime (Module) {
    const appRouteHook = hooks.find(({ options }) => options.filePattern?.includes('app-route'))

    assert.ok(appRouteHook, 'app-route runtime hook should be registered')
    appRouteHook.hook({ AppRouteRouteModule: Module })
  }

  function instrumentPagesApiRuntime (Module) {
    const pagesApiHook = hooks.find(({ options }) => options.filePattern?.includes('pages-api'))

    assert.ok(pagesApiHook, 'pages-api runtime hook should be registered')
    pagesApiHook.hook({ PagesAPIRouteModule: Module })
  }

  function instrumentAppPageRuntime (Module) {
    const appPageHook = hooks.find(({ options }) => options.filePattern?.includes('app-page'))

    assert.ok(appPageHook, 'app-page runtime hook should be registered')
    appPageHook.hook({ AppPageRouteModule: Module })
  }

  it('should publish request lifecycle events for app route handle', async () => {
    class AppRouteRouteModule {
      constructor () {
        this.definition = { pathname: '/api/ping', page: '/api/ping/route' }
      }

      handle () {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
    }

    instrumentAppRouteRuntime(AppRouteRouteModule)

    const req = {
      method: 'GET',
      url: 'http://localhost/api/ping?burst=1',
      headers: {},
      nextUrl: { pathname: '/api/ping' },
    }

    const response = await new AppRouteRouteModule().handle(req, {})

    assert.strictEqual(response.status, 204)
    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:query-parsed',
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:finish',
    ])
    assert.deepStrictEqual(events[0].message, { query: { burst: ['1'] } })
    assert.strictEqual(events[1].message.req, req)
    assert.strictEqual(events[1].message.res.statusCode, 204)
    assert.deepStrictEqual(events[2].message, {
      page: '/api/ping',
      isFilesystemPath: false,
      isAppPath: true,
    })
    assert.strictEqual(events[3].message.res.statusCode, 204)
    assert.strictEqual(events[3].message.nextRequest, req)
  })

  it('should publish app route handle errors', async () => {
    const error = new Error('route failed')

    class AppRouteRouteModule {
      constructor () {
        this.definition = { page: '/api/fail/route' }
      }

      handle () {
        return Promise.reject(error)
      }
    }

    instrumentAppRouteRuntime(AppRouteRouteModule)

    await assert.rejects(
      new AppRouteRouteModule().handle({
        method: 'GET',
        url: 'http://localhost/api/fail',
        headers: {},
        nextUrl: { pathname: '/api/fail' },
      }, {}),
      error
    )

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:error',
      'apm:next:request:finish',
    ])
    assert.strictEqual(events[2].message.error, error)
    assert.strictEqual(events[3].message.error, error)
    assert.strictEqual(events[3].message.res.statusCode, 500)
  })

  it('should not double instrument app route handle calls for the same request', async () => {
    class AppRouteRouteModule {
      constructor () {
        this.definition = { pathname: '/api/ping' }
      }

      handle () {
        return Promise.resolve(new Response(null, { status: 200 }))
      }
    }

    instrumentAppRouteRuntime(AppRouteRouteModule)

    const req = {
      method: 'GET',
      url: 'http://localhost/api/ping',
      headers: {},
    }
    const route = new AppRouteRouteModule()

    await route.handle(req, {})
    await route.handle(req, {})

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:finish',
    ])
  })

  it('should publish request lifecycle events for app page render', async () => {
    class AppPageRouteModule {
      constructor () {
        this.definition = { pathname: '/rsc', page: '/rsc/page' }
      }

      render () {
        return Promise.resolve({ metadata: { statusCode: 204 } })
      }
    }

    instrumentAppPageRuntime(AppPageRouteModule)

    const req = {
      method: 'GET',
      url: 'http://localhost/rsc?burst=1',
      headers: {},
    }
    const res = { statusCode: 200 }

    const result = await new AppPageRouteModule().render(
      { originalRequest: req },
      { originalResponse: res },
      { page: '/fallback/page' }
    )

    assert.deepStrictEqual(result, { metadata: { statusCode: 204 } })
    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:query-parsed',
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:finish',
    ])
    assert.deepStrictEqual(events[0].message, { query: { burst: ['1'] } })
    assert.strictEqual(events[1].message.req, req)
    assert.strictEqual(events[1].message.res, res)
    assert.deepStrictEqual(events[2].message, {
      page: '/rsc',
      isFilesystemPath: false,
      isAppPath: true,
    })
    assert.strictEqual(events[3].message.res.statusCode, 204)
  })

  it('should not double instrument app page render calls for the same request', async () => {
    class AppPageRouteModule {
      constructor () {
        this.definition = { page: '/streaming/page' }
      }

      render () {
        return Promise.resolve({ metadata: { statusCode: 200 } })
      }
    }

    instrumentAppPageRuntime(AppPageRouteModule)

    const req = {
      method: 'GET',
      url: 'http://localhost/streaming',
      headers: {},
    }
    const res = { statusCode: 200 }
    const routeModule = new AppPageRouteModule()

    await routeModule.render({ originalRequest: req }, { originalResponse: res }, {})
    await routeModule.render({ originalRequest: req }, { originalResponse: res }, {})

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:finish',
    ])
  })

  it('should publish app page render errors', async () => {
    const error = new Error('app page failed')

    class AppPageRouteModule {
      constructor () {
        this.definition = { page: '/actions/page' }
      }

      render () {
        return Promise.reject(error)
      }
    }

    instrumentAppPageRuntime(AppPageRouteModule)

    await assert.rejects(
      new AppPageRouteModule().render({
        originalRequest: {
          method: 'POST',
          url: 'http://localhost/actions',
          headers: {},
        },
      }, { originalResponse: { statusCode: 200 } }, {}),
      error
    )

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:error',
      'apm:next:request:finish',
    ])
    assert.strictEqual(events[2].message.error, error)
    assert.strictEqual(events[3].message.error, error)
    assert.strictEqual(events[3].message.res.statusCode, 500)
  })

  it('should publish request lifecycle events for pages api render', async () => {
    class PagesAPIRouteModule {
      constructor () {
        this.definition = { pathname: '/api/pages-ping', page: '/api/pages-ping' }
      }

      render (req, res) {
        res.statusCode = 204
        return Promise.resolve()
      }
    }

    instrumentPagesApiRuntime(PagesAPIRouteModule)

    const req = {
      method: 'GET',
      url: 'http://localhost/api/pages-ping?burst=1',
      headers: {},
    }
    const res = { statusCode: 200 }

    await new PagesAPIRouteModule().render(req, res, {})

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:query-parsed',
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:finish',
    ])
    assert.deepStrictEqual(events[0].message, { query: { burst: ['1'] } })
    assert.strictEqual(events[1].message.req, req)
    assert.strictEqual(events[1].message.res, res)
    assert.deepStrictEqual(events[2].message, { page: '/api/pages-ping', isFilesystemPath: false })
    assert.strictEqual(events[3].message.res.statusCode, 204)
  })

  it('should publish pages api render errors', async () => {
    const error = new Error('pages api failed')

    class PagesAPIRouteModule {
      constructor () {
        this.definition = { page: '/api/pages-fail' }
      }

      render () {
        return Promise.reject(error)
      }
    }

    instrumentPagesApiRuntime(PagesAPIRouteModule)

    await assert.rejects(
      new PagesAPIRouteModule().render({
        method: 'GET',
        url: 'http://localhost/api/pages-fail',
        headers: {},
      }, { statusCode: 500 }, {}),
      error
    )

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:error',
      'apm:next:request:finish',
    ])
    assert.strictEqual(events[2].message.error, error)
    assert.strictEqual(events[3].message.error, error)
    assert.strictEqual(events[3].message.res.statusCode, 500)
  })

  it('should not double instrument pages api render calls for the same request', async () => {
    class PagesAPIRouteModule {
      constructor () {
        this.definition = { pathname: '/api/pages' }
      }

      render () {
        return Promise.resolve()
      }
    }

    instrumentPagesApiRuntime(PagesAPIRouteModule)

    const req = {
      method: 'GET',
      url: 'http://localhost/api/pages',
      headers: {},
    }
    const res = { statusCode: 200 }
    const route = new PagesAPIRouteModule()

    await route.render(req, res, {})
    await route.render(req, res, {})

    assert.deepStrictEqual(events.map(event => event.name), [
      'apm:next:request:start',
      'apm:next:page:load',
      'apm:next:request:finish',
    ])
  })
})
