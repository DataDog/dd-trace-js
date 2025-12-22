'use strict'

const assert = require('node:assert/strict')
const { promisify } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const { ERROR_TYPE, ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const PLUGINS = ['dns', 'node:dns']

describe('Plugin', () => {
  let dns
  let tracer
  PLUGINS.forEach(plugin => {
    describe(plugin, () => {
      afterEach(() => {
        return agent.close()
      })

      beforeEach(() => {
        return agent.load('dns')
          .then(() => {
            dns = require(plugin)
            tracer = require('../../dd-trace')
          })
      })

      it('should instrument lookup', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.address': '127.0.0.1'
            })
          })
          .then(done)
          .catch(done)

        dns.lookup('localhost', 4, (err, address, family) => err && done(err))
      })

      it('should instrument lookup with all addresses', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.address': '127.0.0.1',
              'dns.addresses': '127.0.0.1,::1'
            })
          })
          .then(done)
          .catch(done)

        dns.lookup('localhost', { all: true }, (err, address, family) => err && done(err))
      })

      it('should instrument errors correctly', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'fakedomain.faketld',
              error: 1
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'fakedomain.faketld',
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: 'getaddrinfo ENOTFOUND fakedomain.faketld'
            })
          })
          .then(done)
          .catch(done)

        dns.lookup('fakedomain.faketld', 4, (err, address, family) => {
          assert.notStrictEqual(err, null)
        })
      })

      it('should instrument lookupService', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup_service',
              service: 'test',
              resource: '127.0.0.1:22'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.address': '127.0.0.1'
            })
            assertObjectContains(traces[0][0].metrics, {
              'dns.port': 22
            })
          })
          .then(done)
          .catch(done)

        dns.lookupService('127.0.0.1', 22, err => err && done(err))
      })

      it('should instrument resolve', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'A lvh.me'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'lvh.me',
              'dns.rrtype': 'A'
            })
          })
          .then(done)
          .catch(done)

        dns.resolve('lvh.me', err => err && done(err))
      })

      it('should instrument resolve shorthands', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'ANY localhost'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.rrtype': 'ANY'
            })
          })
          .then(done)
          .catch(done)

        dns.resolveAny('localhost', () => done())
      })

      it('should instrument reverse', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.reverse',
              service: 'test',
              resource: '127.0.0.1'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.ip': '127.0.0.1'
            })
          })
          .then(done)
          .catch(done)

        dns.reverse('127.0.0.1', err => err && done(err))
      })

      it('should preserve the parent scope in the callback', done => {
        const span = tracer.startSpan('dummySpan', {})

        tracer.scope().activate(span, () => {
          dns.lookup('localhost', 4, (err) => {
            if (err) return done(err)

            assert.strictEqual(tracer.scope().active(), span)

            done()
          })
        })
      })

      it('should work with promisify', () => {
        const lookup = promisify(dns.lookup)

        return lookup('localhost', 4).then(({ address, family }) => {
          assert.strictEqual(address, '127.0.0.1')
          assert.strictEqual(family, 4)
        })
      })

      it('should instrument Resolver', done => {
        const resolver = new dns.Resolver()

        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'A lvh.me'
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'dns.hostname': 'lvh.me',
              'dns.rrtype': 'A'
            })
          })
          .then(done)
          .catch(done)

        resolver.resolve('lvh.me', err => err && done(err))
      })

      it('should skip instrumentation for noop context', done => {
        const resolver = new dns.Resolver()
        const timer = setTimeout(done, 200)

        agent
          .assertSomeTraces(() => {
            done(new Error('Resolve was traced.'))
            clearTimeout(timer)
          })

        storage('legacy').run({ noop: true }, () => {
          resolver.resolve('lvh.me', () => {})
        })
      })
    })
  })
})
