'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { afterEach, beforeEach, describe, it } = require('mocha')

const { channel } = require('../../src/helpers/instrument')
const {
  joinPath,
  normalizeRoutePath,
  normalizeRoutePaths,
  getRouteFullPaths,
  wrapRouteMethodsAndPublish,
  setRouterMountPath,
  getRouterMountPaths,
  extractMountPaths,
  hasRouterCycle,
  collectRoutesFromRouter,
  setLayerMatchers,
  isAppMounted
} = require('../../src/helpers/router-helper')

describe('helpers/router-helper', () => {
  describe('normalizeRoutePath', () => {
    it('should return null for nullish values', () => {
      assert.strictEqual(normalizeRoutePath(null), null)
      assert.strictEqual(normalizeRoutePath(undefined), null)
    })

    it('should convert regular expressions to strings', () => {
      const regex = /^\/item\/(\d+)$/
      assert.strictEqual(normalizeRoutePath(regex), regex.toString())
    })

    it('should stringify non-string primitives', () => {
      assert.strictEqual(normalizeRoutePath(42), '42')
      assert.strictEqual(normalizeRoutePath(true), 'true')
    })
  })

  describe('normalizeRoutePaths', () => {
    it('should wrap a single string path in an array', () => {
      assert.deepStrictEqual(normalizeRoutePaths('/foo'), ['/foo'])
    })

    it('should flatten nested arrays', () => {
      const input = ['/one', ['/two', ['/three']]]
      assert.deepStrictEqual(normalizeRoutePaths(input), ['/one', '/two', '/three'])
    })

    it('should normalize mixed values', () => {
      const regex = /^\/item\/(\d+)$/
      const input = ['/base', [regex, null, undefined]]
      assert.deepStrictEqual(normalizeRoutePaths(input), ['/base', regex.toString()])
    })
  })

  describe('getRouteFullPaths', () => {
    it('should combine route paths with prefix', () => {
      const route = { path: '/child' }
      assert.deepStrictEqual(getRouteFullPaths(route, '/parent'), ['/parent/child'])
    })

    it('should handle routes without explicit path', () => {
      const route = { path: '' }
      assert.deepStrictEqual(getRouteFullPaths(route, '/parent'), ['/parent'])
    })

    it('should fan out multiple route paths', () => {
      const route = { path: ['/one', '/two'] }
      assert.deepStrictEqual(getRouteFullPaths(route, '/base'), ['/base/one', '/base/two'])
    })
  })

  describe('joinPath', () => {
    it('should join base and child paths', () => {
      assert.strictEqual(joinPath('/base', '/child'), '/base/child')
    })

    it('should handle root base', () => {
      assert.strictEqual(joinPath('/', '/child'), '/child')
    })

    it('should handle root path', () => {
      assert.strictEqual(joinPath('/base', '/'), '/base')
    })

    it('should return root when both parts empty', () => {
      assert.strictEqual(joinPath('', ''), '/')
    })

    it('should avoid duplicate slashes when base ends with slash', () => {
      expect(joinPath('/^\\/regex(?:\\/|$)/', '/mounted')).to.equal('/^\\/regex(?:\\/|$)/mounted')
    })

    it('should return null for path without leading slash (not accessible in Express)', () => {
      assert.strictEqual(joinPath('/v1', 'nested'), null)
    })

    it('should return null for base without leading slash (not accessible in Express)', () => {
      assert.strictEqual(joinPath('v1', '/nested'), null)
    })

    it('should return null for both base and path without leading slashes', () => {
      assert.strictEqual(joinPath('v1', 'nested'), null)
    })

    it('should handle empty string path (used for routes without explicit path)', () => {
      assert.strictEqual(joinPath('/v1', ''), '/v1')
    })

    it('should handle base with trailing slash and path with leading slash correctly', () => {
      assert.strictEqual(joinPath('/v1/', '/nested'), '/v1/nested')
    })
  })

  describe('router mount path helpers', () => {
    it('should accumulate multiple mount paths', () => {
      const router = function () {}

      setRouterMountPath(router, '/foo')
      setRouterMountPath(router, '/bar')

      expect(getRouterMountPaths(router)).to.have.members(['/foo', '/bar'])
    })

    it('should avoid duplicate mount paths', () => {
      const router = function () {}

      setRouterMountPath(router, '/dup')
      setRouterMountPath(router, '/dup')

      assert.deepStrictEqual(getRouterMountPaths(router), ['/dup'])
    })
  })

  describe('extractMountPaths', () => {
    it('should default to root when no mount path provided', () => {
      const { mountPaths, startIdx } = extractMountPaths(() => {})

      assert.deepStrictEqual(mountPaths, ['/'])
      assert.strictEqual(startIdx, 0)
    })

    it('should normalize string mount paths', () => {
      const { mountPaths, startIdx } = extractMountPaths('/test')

      assert.deepStrictEqual(mountPaths, ['/test'])
      assert.strictEqual(startIdx, 1)
    })

    it('should flatten array mount paths including regex', () => {
      const regex = /\/foo/
      const { mountPaths, startIdx } = extractMountPaths([[['/one'], regex]])

      assert.deepStrictEqual(mountPaths, ['/one', regex.toString()])
      assert.strictEqual(startIdx, 1)
    })

    it('should ignore handlers as mount paths', () => {
      const { mountPaths, startIdx } = extractMountPaths(function handler () {})

      assert.deepStrictEqual(mountPaths, ['/'])
      assert.strictEqual(startIdx, 0)
    })
  })

  describe('hasRouterCycle', () => {
    it('should return false for acyclic routers', () => {
      const leaf = { stack: [] }
      const parent = { stack: [{ handle: leaf }] }

      assert.strictEqual(hasRouterCycle(parent), false)
    })

    it('should detect cycles between routers', () => {
      const a = { stack: [] }
      const b = { stack: [] }

      a.stack.push({ handle: b })
      b.stack.push({ handle: a })

      assert.strictEqual(hasRouterCycle(a), true)
    })

    it('should consider router referencing itself a cycle', () => {
      const router = { stack: [] }
      router.stack.push({ handle: router })

      assert.strictEqual(hasRouterCycle(router), true)
    })
  })

  describe('collectRoutesFromRouter', () => {
    const routeAddedChannel = channel('apm:express:route:added')
    let published
    let subscription

    beforeEach(() => {
      published = []
      subscription = (payload) => {
        published.push(payload)
      }
      routeAddedChannel.subscribe(subscription)
    })

    afterEach(() => {
      routeAddedChannel.unsubscribe(subscription)
    })

    it('should publish direct routes with all enabled methods', () => {
      const router = {
        stack: [{
          route: {
            path: '',
            methods: {
              get: true,
              post: true,
              delete: false
            }
          }
        }]
      }

      collectRoutesFromRouter(router, '/api')

      assert.deepStrictEqual(published, [
        { method: 'get', path: '/api' },
        { method: 'post', path: '/api' }
      ])
    })

    it('should traverse nested routers and mark them mounted', () => {
      const childRouter = {
        stack: [{
          route: {
            path: '/nested',
            methods: { get: true }
          }
        }]
      }

      const parentRouter = {
        stack: [{
          handle: childRouter,
          path: '/sub'
        }]
      }

      collectRoutesFromRouter(parentRouter, '/api')

      assert.deepStrictEqual(published, [
        { method: 'get', path: '/api/sub/nested' }
      ])
      assert.deepStrictEqual(getRouterMountPaths(childRouter), ['/api/sub'])
      assert.strictEqual(isAppMounted(childRouter), true)
    })

    it('should use layer matchers when mount path is not a string', () => {
      const childRouter = {
        stack: [{
          route: {
            path: '/details',
            methods: { all: true }
          }
        }]
      }

      const layer = {
        handle: childRouter,
        path: undefined
      }

      setLayerMatchers(layer, [{ path: '/dynamic' }])

      const parentRouter = {
        stack: [layer]
      }

      collectRoutesFromRouter(parentRouter, '/root')

      assert.deepStrictEqual(published, [
        { method: '*', path: '/root/dynamic/details' }
      ])
      assert.deepStrictEqual(getRouterMountPaths(childRouter), ['/root/dynamic'])
    })
  })

  describe('wrapRouteMethodsAndPublish', () => {
    it('should wrap route methods and publish for each path', () => {
      const calls = []
      const published = []
      const route = {
        get (...args) {
          calls.push({ args, context: this })
          return 'result'
        }
      }

      wrapRouteMethodsAndPublish(route, ['/path-a', '/path-b'], (payload) => {
        published.push(payload)
      })

      const context = { foo: 'bar' }
      const returnValue = route.get.call(context, 'arg1', 'arg2')

      assert.strictEqual(returnValue, 'result')
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].context, context)
      assert.deepStrictEqual(calls[0].args, ['arg1', 'arg2'])
      assert.deepStrictEqual(published, [
        { method: 'get', path: '/path-a' },
        { method: 'get', path: '/path-b' }
      ])
    })

    it('should publish once per unique path', () => {
      const published = []
      const route = {
        get () {}
      }

      wrapRouteMethodsAndPublish(route, ['/dup', '/dup'], published.push.bind(published))
      route.get()

      assert.deepStrictEqual(published, [{ method: 'get', path: '/dup' }])
    })

    it('should normalise method names for all()', () => {
      const published = []
      const route = {
        all () {}
      }

      wrapRouteMethodsAndPublish(route, ['/test'], published.push.bind(published))
      route.all()

      assert.deepStrictEqual(published, [{ method: '*', path: '/test' }])
    })

    it('should no-op when no paths provided', () => {
      const route = { get: () => { throw new Error('should not get here') } }
      const original = route.get
      let published = false

      wrapRouteMethodsAndPublish(route, [], () => {
        published = true
      })

      assert.strictEqual(route.get, original)
      assert.strictEqual(published, false)
    })
  })
})
