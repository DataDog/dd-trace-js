'use strict'

const proxyquire = require('proxyquire').noCallThru()

describe('Instrumenter', () => {
  let Instrumenter
  let instrumenter
  let integrations
  let tracer
  let requireDir

  beforeEach(() => {
    tracer = 'tracer'

    integrations = {
      http: {
        name: 'http',
        patch: sinon.spy(),
        unpatch: sinon.spy()
      },
      express: {
        name: 'express',
        versions: ['4.x'],
        patch: sinon.spy(),
        unpatch: sinon.spy()
      }
    }

    requireDir = sinon.stub()
    requireDir.withArgs('./plugins').returns(integrations)

    Instrumenter = proxyquire('../src/instrumenter', {
      'require-dir': requireDir
    })
  })

  describe('when enabled', () => {
    beforeEach(() => {
      instrumenter = new Instrumenter(tracer, { plugins: true })
    })

    describe('use', () => {
      it('should allow configuring a plugin', () => {
        const config = { foo: 'bar' }

        instrumenter.use('express', config)
        instrumenter.patch()

        const express = require('express')

        expect(integrations.express.patch).to.have.been.calledWith(express, tracer, config)
      })

      it('should default to an empty plugin configuration', () => {
        instrumenter.use('express')
        instrumenter.patch()

        const express = require('express')

        expect(integrations.express.patch).to.have.been.calledWith(express, tracer, {})
      })
    })

    describe('patch', () => {
      it('should patch modules from node_modules when they are loaded', () => {
        instrumenter.patch()

        const express = require('express')

        expect(integrations.express.patch).to.have.been.calledWith(express, tracer)
      })

      it('should only patch a module if its version is supported by the plugin ', () => {
        integrations.express.versions = ['^3.0.0']
        instrumenter.patch()

        const express = require('express')

        expect(integrations.express.patch).to.not.have.been.calledWith(express, tracer)
      })

      it('should patch native modules when they are loaded', () => {
        instrumenter.patch()

        const http = require('http')

        expect(integrations.http.patch).to.have.been.called
        expect(integrations.http.patch).to.have.been.calledWith(http, tracer)
      })
    })

    describe('unpatch', () => {
      it('should unpatch patched modules', () => {
        instrumenter.patch()

        const express = require('express')

        instrumenter.unpatch()

        expect(integrations.express.unpatch).to.have.been.calledWith(express)
      })
    })
  })

  describe('when disabled', () => {
    beforeEach(() => {
      instrumenter = new Instrumenter(tracer, { plugins: false })
    })

    describe('patch', () => {
      it('should not patch any module', () => {
        instrumenter.patch()

        const express = require('express')

        expect(integrations.express.patch).to.not.have.been.calledWith(express, tracer)
      })
    })
  })
})
