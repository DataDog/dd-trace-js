'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let dns
  let tracer

  describe('dns', () => {
    afterEach(() => {
      return agent.close()
    })

    beforeEach(() => {
      return agent.load(plugin, 'dns')
        .then(() => {
          dns = require('dns')
          tracer = require('../../dd-trace')
        })
    })

    it('should instrument lookup', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'dns.lookup',
            service: 'test-dns',
            resource: 'localhost'
          })
          expect(traces[0][0].meta).to.deep.include({
            'dns.hostname': 'localhost',
            'dns.address': '127.0.0.1',
            'span.kind': 'client'
          })
        })
        .then(done)
        .catch(done)

      dns.lookup('localhost', 4, (err, address, family) => err && done(err))
    })

    it('should instrument lookupService', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'dns.lookup_service',
            service: 'test-dns',
            resource: '127.0.0.1:22'
          })
          expect(traces[0][0].meta).to.deep.include({
            'dns.address': '127.0.0.1',
            'span.kind': 'client'
          })
          expect(traces[0][0].metrics).to.deep.include({
            'dns.port': 22
          })
        })
        .then(done)
        .catch(done)

      dns.lookupService('127.0.0.1', 22, err => err && done(err))
    })

    it('should instrument resolve', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'dns.resolve',
            service: 'test-dns',
            resource: 'A localhost'
          })
          expect(traces[0][0].meta).to.deep.include({
            'dns.hostname': 'localhost',
            'dns.rrtype': 'A',
            'span.kind': 'client'
          })
        })
        .then(done)
        .catch(done)

      dns.resolve('localhost', err => err && done(err))
    })

    it('should instrument resolve shorthands', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'dns.resolve',
            service: 'test-dns',
            resource: 'ANY localhost'
          })
          expect(traces[0][0].meta).to.deep.include({
            'dns.hostname': 'localhost',
            'dns.rrtype': 'ANY',
            'span.kind': 'client'
          })
        })
        .then(done)
        .catch(done)

      dns.resolveAny('localhost', err => err && done(err))
    })

    it('should instrument reverse', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'dns.reverse',
            service: 'test-dns',
            resource: '127.0.0.1'
          })
          expect(traces[0][0].meta).to.deep.include({
            'dns.ip': '127.0.0.1',
            'span.kind': 'client'
          })
        })
        .then(done)
        .catch(done)

      dns.reverse('127.0.0.1', err => err && done(err))
    })

    it('should preserve the parent scope in the callback', done => {
      const span = {}

      tracer.scope().activate(span, () => {
        dns.lookup('localhost', 4, (err) => {
          if (err) return done(err)

          expect(tracer.scope().active()).to.equal(span)

          done()
        })
      })
    })

    if (semver.gte(process.version, '8.3.0')) {
      it('should instrument Resolver', done => {
        const resolver = new dns.Resolver()

        agent
          .use(traces => {
            expect(traces[0][0]).to.deep.include({
              name: 'dns.resolve',
              service: 'test-dns',
              resource: 'A localhost'
            })
            expect(traces[0][0].meta).to.deep.include({
              'dns.hostname': 'localhost',
              'dns.rrtype': 'A',
              'span.kind': 'client'
            })
          })
          .then(done)
          .catch(done)

        resolver.resolve('localhost', err => err && done(err))
      })
    }
  })
})
