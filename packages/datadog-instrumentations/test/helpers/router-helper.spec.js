'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

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

describe.only('helpers/router-helper', () => {
  describe('normalizeRoutePath', () => {
    it('should return null for nullish values', () => {
      expect(normalizeRoutePath(null)).to.equal(null)
      expect(normalizeRoutePath(undefined)).to.equal(null)
    })

    it('should convert regular expressions to strings', () => {
      const regex = /^\/item\/(\d+)$/
      expect(normalizeRoutePath(regex)).to.equal(regex.toString())
    })

    it('should stringify non-string primitives', () => {
      expect(normalizeRoutePath(42)).to.equal('42')
      expect(normalizeRoutePath(true)).to.equal('true')
    })
  })

  describe('normalizeRoutePaths', () => {
    it('should wrap a single string path in an array', () => {
      expect(normalizeRoutePaths('/foo')).to.deep.equal(['/foo'])
    })

    it('should flatten nested arrays', () => {
      const input = ['/one', ['/two', ['/three']]]
      expect(normalizeRoutePaths(input)).to.deep.equal(['/one', '/two', '/three'])
    })

    it('should normalize mixed values', () => {
      const regex = /^\/item\/(\d+)$/
      const input = ['/base', [regex, null, undefined]]
      expect(normalizeRoutePaths(input)).to.deep.equal(['/base', regex.toString()])
    })
  })

  describe('getRouteFullPaths', () => {
    it('should combine route paths with prefix', () => {
      const route = { path: '/child' }
      expect(getRouteFullPaths(route, '/parent')).to.deep.equal(['/parent/child'])
    })

    it('should handle routes without explicit path', () => {
      const route = { path: '' }
      expect(getRouteFullPaths(route, '/parent')).to.deep.equal(['/parent'])
    })

    it('should fan out multiple route paths', () => {
      const route = { path: ['/one', '/two'] }
      expect(getRouteFullPaths(route, '/base')).to.deep.equal(['/base/one', '/base/two'])
    })
  })

  describe('joinPath', () => {
    it('should join base and child paths', () => {
      expect(joinPath('/base', '/child')).to.equal('/base/child')
    })

    it('should handle root base', () => {
      expect(joinPath('/', '/child')).to.equal('/child')
    })

    it('should handle root path', () => {
      expect(joinPath('/base', '/')).to.equal('/base')
    })

    it('should return root when both parts empty', () => {
      expect(joinPath('', '')).to.equal('/')
    })

    it('should avoid duplicate slashes when base ends with slash', () => {
      expect(joinPath('/^\\/regex(?:\\/|$)/', '/mounted')).to.equal('/^\\/regex(?:\\/|$)/mounted')
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

      expect(getRouterMountPaths(router)).to.deep.equal(['/dup'])
    })
  })

  describe('extractMountPaths', () => {
    it('should default to root when no mount path provided', () => {
      const { mountPaths, startIdx } = extractMountPaths(() => {})

      expect(mountPaths).to.deep.equal(['/'])
      expect(startIdx).to.equal(0)
    })

    it('should normalize string mount paths', () => {
      const { mountPaths, startIdx } = extractMountPaths('/test')

      expect(mountPaths).to.deep.equal(['/test'])
      expect(startIdx).to.equal(1)
    })

    it('should flatten array mount paths including regex', () => {
      const regex = /\/foo/
      const { mountPaths, startIdx } = extractMountPaths([[['/one'], regex]])

      expect(mountPaths).to.deep.equal(['/one', regex.toString()])
      expect(startIdx).to.equal(1)
    })

    it('should ignore handlers as mount paths', () => {
      const { mountPaths, startIdx } = extractMountPaths(function handler () {})

      expect(mountPaths).to.deep.equal(['/'])
      expect(startIdx).to.equal(0)
    })
  })

  describe('hasRouterCycle', () => {
    it('should return false for acyclic routers', () => {
      const leaf = { stack: [] }
      const parent = { stack: [{ handle: leaf }] }

      expect(hasRouterCycle(parent)).to.be.false
    })

    it('should detect cycles between routers', () => {
      const a = { stack: [] }
      const b = { stack: [] }

      a.stack.push({ handle: b })
      b.stack.push({ handle: a })

      expect(hasRouterCycle(a)).to.be.true
    })

    it('should consider router referencing itself a cycle', () => {
      const router = { stack: [] }
      router.stack.push({ handle: router })

      expect(hasRouterCycle(router)).to.be.true
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

      expect(published).to.deep.equal([
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

      expect(published).to.deep.equal([
        { method: 'get', path: '/api/sub/nested' }
      ])
      expect(getRouterMountPaths(childRouter)).to.deep.equal(['/api/sub'])
      expect(isAppMounted(childRouter)).to.be.true
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

      expect(published).to.deep.equal([
        { method: '*', path: '/root/dynamic/details' }
      ])
      expect(getRouterMountPaths(childRouter)).to.deep.equal(['/root/dynamic'])
    })
  })

  describe('wrapRouteMethodsAndPublish', () => {
    it('should wrap route methods and publish for each path', () => {
      const calls = []
      const published = []
      const route = {
        get () {
          calls.push({ args: Array.from(arguments), context: this })
          return 'result'
        }
      }

      wrapRouteMethodsAndPublish(route, ['/path-a', '/path-b'], (payload) => {
        published.push(payload)
      })

      const context = { foo: 'bar' }
      const returnValue = route.get.call(context, 'arg1', 'arg2')

      expect(returnValue).to.equal('result')
      expect(calls).to.have.length(1)
      expect(calls[0].context).to.equal(context)
      expect(calls[0].args).to.deep.equal(['arg1', 'arg2'])
      expect(published).to.deep.equal([
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

      expect(published).to.deep.equal([{ method: 'get', path: '/dup' }])
    })

    it('should normalise method names for all()', () => {
      const published = []
      const route = {
        all () {}
      }

      wrapRouteMethodsAndPublish(route, ['/test'], published.push.bind(published))
      route.all()

      expect(published).to.deep.equal([{ method: '*', path: '/test' }])
    })

    it('should no-op when no paths provided', () => {
      const route = { get: () => { throw new Error('should not get here') } }
      const original = route.get
      let published = false

      wrapRouteMethodsAndPublish(route, [], () => {
        published = true
      })

      expect(route.get).to.equal(original)
      expect(published).to.be.false
    })
  })
})
