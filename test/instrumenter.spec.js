'use strict'

const path = require('path')
const proxyquire = require('proxyquire').noCallThru()

describe('Instrumenter', () => {
  let Instrumenter
  let instrumenter
  let integrations
  let tracer
  let requireDir
  let Connection
  let Pool
  let plugins

  beforeEach(() => {
    tracer = {
      _tracer: 'tracer'
    }

    integrations = {
      http: {
        name: 'http',
        patch: sinon.spy(),
        unpatch: sinon.spy()
      },
      express: {
        name: 'express-mock',
        versions: ['4.x'],
        patch: sinon.spy(),
        unpatch: sinon.spy()
      },
      mysql: [
        {
          name: 'mysql-mock',
          versions: ['2.x'],
          file: 'lib/Connection.js',
          patch: sinon.spy(),
          unpatch: sinon.spy()
        },
        {
          name: 'mysql-mock',
          versions: ['2.x'],
          file: 'lib/Pool.js',
          patch: sinon.spy(),
          unpatch: sinon.spy()
        }
      ]
    }

    plugins = {
      other: {
        name: 'other',
        versions: ['1.x'],
        patch: sinon.spy(),
        unpatch: sinon.spy()
      }
    }

    const mysqlDir = path.normalize(path.join(__dirname, 'node_modules', 'mysql-mock'))
    const connectionPath = path.join(mysqlDir, 'lib', 'Connection.js')
    const poolPath = path.join(mysqlDir, 'lib', 'Pool.js')

    Connection = 'Connection'
    Pool = 'Pool'

    requireDir = sinon.stub()
    requireDir.withArgs('./plugins').returns(integrations)

    Instrumenter = proxyquire('../src/instrumenter', {
      'require-dir': requireDir,
      [connectionPath]: Connection,
      [poolPath]: Pool
    })

    instrumenter = new Instrumenter(tracer)
  })

  describe('with integrations enabled', () => {
    describe('use', () => {
      it('should allow configuring a plugin by name', () => {
        const config = { foo: 'bar' }

        instrumenter.use('express-mock', config)
        instrumenter.patch()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', config)
      })

      it('should allow configuring a plugin by instance', () => {
        const config = { foo: 'bar' }

        instrumenter.use(integrations.express, config)
        instrumenter.patch()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', config)
      })

      it('should default to an empty plugin configuration', () => {
        instrumenter.use('express-mock')
        instrumenter.patch()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', {})
      })

      it('should support a plugin instance', () => {
        const express = require('express-mock')

        instrumenter.use(express)
        instrumenter.patch()

        require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', {})
      })

      it('should reapply the require hook when called multiple times', () => {
        instrumenter.use('mysql-mock')
        instrumenter.use('express-mock')
        instrumenter.patch()

        require('express-mock')

        expect(integrations.express.patch).to.have.been.called
      })

      it('should support third party plugins', () => {
        instrumenter.use(plugins.other)
        instrumenter.patch()

        const other = require('other')

        expect(plugins.other.patch).to.have.been.calledWith(other, 'tracer', {})
      })
    })

    describe('patch', () => {
      it('should patch modules from node_modules when they are loaded', () => {
        instrumenter.patch()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', {})
      })

      it('should only patch a module if its version is supported by the plugin ', () => {
        integrations.express.versions = ['^3.0.0']
        instrumenter.patch()

        const express = require('express-mock')

        expect(integrations.express.patch).to.not.have.been.calledWith(express, 'tracer', {})
      })

      it('should patch native modules when they are loaded', () => {
        instrumenter.patch()

        const http = require('http')

        expect(integrations.http.patch).to.have.been.called
        expect(integrations.http.patch).to.have.been.calledWith(http, 'tracer', {})
      })

      it('should support patching multiple files', () => {
        instrumenter.patch()

        const mysql = require('mysql-mock')

        expect(mysql).to.deep.equal({ foo: 'bar' })
        expect(integrations.mysql[0].patch).to.have.been.calledWith(Connection, 'tracer', {})
        expect(integrations.mysql[1].patch).to.have.been.calledWith(Pool, 'tracer', {})
      })
    })

    describe('unpatch', () => {
      it('should unpatch patched modules', () => {
        instrumenter.patch()

        const express = require('express-mock')

        instrumenter.unpatch()

        expect(integrations.express.unpatch).to.have.been.calledWith(express)
      })
    })
  })

  describe('with integrations disabled', () => {
    describe('use', () => {
      it('should still allow adding plugins manually by name', () => {
        instrumenter.use('express-mock')
        instrumenter.patch({ plugins: false })

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', {})
      })
    })

    it('should support an array of plugins', () => {
      instrumenter.use(integrations.mysql)
      instrumenter.patch({ plugins: false })

      require('mysql-mock')

      expect(integrations.mysql[0].patch).to.have.been.calledWith(Connection, 'tracer', {})
      expect(integrations.mysql[1].patch).to.have.been.calledWith(Pool, 'tracer', {})
    })

    describe('patch', () => {
      it('should not patch any module', () => {
        instrumenter.patch({ plugins: false })

        const express = require('express-mock')

        expect(integrations.express.patch).to.not.have.been.calledWith(express, 'tracer', {})
      })
    })
  })
})
