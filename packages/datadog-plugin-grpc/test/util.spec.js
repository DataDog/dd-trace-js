'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const { addMetadataTags, getEmptyObject, getFilter, getMethodMetadata } = require('../src/util')

describe('grpc util', () => {
  describe('getMethodMetadata', () => {
    it('parses a fully-qualified method path', () => {
      const result = getMethodMetadata('/pkg.sub.Service/Method', 'unary')
      assert.deepStrictEqual(result, {
        path: '/pkg.sub.Service/Method',
        kind: 'unary',
        name: 'Method',
        service: 'Service',
        package: 'pkg.sub',
      })
    })

    it('parses a path without a package', () => {
      const result = getMethodMetadata('/Service/Method', 'serverStream')
      assert.deepStrictEqual(result, {
        path: '/Service/Method',
        kind: 'serverStream',
        name: 'Method',
        service: 'Service',
        package: '',
      })
    })

    it('falls back when the path is not fully qualified', () => {
      const result = getMethodMetadata('LegacyMethod', 'unary')
      assert.deepStrictEqual(result, {
        path: 'LegacyMethod',
        kind: 'unary',
        name: 'LegacyMethod',
        service: '',
        package: '',
      })
    })

    it('returns empty fields when the path is not a string', () => {
      const result = getMethodMetadata(undefined, 'unary')
      assert.deepStrictEqual(result, {
        path: undefined,
        kind: 'unary',
        name: '',
        service: '',
        package: '',
      })
    })

    it('threads the kind through on a cache hit', () => {
      const path = '/cache.Hit.Service/Method'
      const first = getMethodMetadata(path, 'unary')
      const second = getMethodMetadata(path, 'serverStream')
      assert.strictEqual(first.kind, 'unary')
      assert.strictEqual(second.kind, 'serverStream')
      assert.strictEqual(first.name, second.name)
      assert.strictEqual(first.service, second.service)
      assert.strictEqual(first.package, second.package)
    })
  })

  describe('addMetadataTags', () => {
    function fakeMetadata (map) {
      return { getMap: () => map }
    }

    function fakeSpan () {
      const tags = {}
      return {
        tags,
        setTag (key, value) { tags[key] = value },
      }
    }

    it('skips the metadata clone when the default empty filter is in use', () => {
      const span = fakeSpan()
      let called = false
      const metadata = {
        getMap () {
          called = true
          return { traceparent: 'should-not-leak' }
        },
      }
      addMetadataTags(span, metadata, getEmptyObject, 'request')
      assert.strictEqual(called, false)
      assert.deepStrictEqual(span.tags, {})
    })

    it('forwards filtered values to setTag on the span', () => {
      const span = fakeSpan()
      const filter = (map) => ({ 'x-trace-id': map['x-trace-id'] })
      addMetadataTags(span, fakeMetadata({ 'x-trace-id': 'abc', secret: 'shh' }), filter, 'request')
      assert.deepStrictEqual(span.tags, { 'grpc.request.metadata.x-trace-id': 'abc' })
    })

    const objectProto = Object.prototype

    afterEach(() => {
      // Defence-in-depth: tests shouldn't leak prototype pollution.
      delete objectProto.injected
    })

    it('does not pick up inherited keys when iterating filter output', () => {
      const span = fakeSpan()
      objectProto.injected = 'leak'
      const filter = () => ({ direct: 'kept' })
      addMetadataTags(span, fakeMetadata({}), filter, 'response')
      assert.deepStrictEqual(span.tags, { 'grpc.response.metadata.direct': 'kept' })
    })
  })

  describe('getFilter', () => {
    it('returns the same empty-object sentinel when no filter is configured', () => {
      const filterA = getFilter({}, 'metadata')
      const filterB = getFilter({}, 'metadata')
      assert.strictEqual(filterA, getEmptyObject)
      assert.strictEqual(filterB, getEmptyObject)
    })

    it('returns the user-provided function as-is', () => {
      const userFilter = (input) => input
      assert.strictEqual(getFilter({ metadata: userFilter }, 'metadata'), userFilter)
    })
  })
})
