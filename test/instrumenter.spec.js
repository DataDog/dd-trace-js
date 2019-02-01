'use strict'

const proxyquire = require('proxyquire').noCallThru()
const path = require('path')

describe('Instrumenter', () => {
  let Instrumenter
  let instrumenter
  let integrations
  let tracer
  let tracerConfig
  let shimmer

  beforeEach(() => {
    tracer = {
      _tracer: 'tracer'
    }

    tracerConfig = { enabled: true }

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
          file: 'lib/connection.js',
          patch: sinon.spy(),
          unpatch: sinon.spy()
        },
        {
          name: 'mysql-mock',
          versions: ['2.x'],
          file: 'lib/pool.js',
          patch: sinon.spy(),
          unpatch: sinon.spy()
        }
      ]
    }

    shimmer = sinon.spy()
    shimmer.massWrap = sinon.spy()
    shimmer.massUnwrap = sinon.spy()

    Instrumenter = proxyquire('../src/instrumenter', {
      'shimmer': shimmer,
      './plugins': {
        'http': integrations.http,
        'express-mock': integrations.express,
        'mysql-mock': integrations.mysql
      },
      './plugins/http': integrations.http,
      './plugins/express-mock': integrations.express,
      './plugins/mysql-mock': integrations.mysql
    })

    instrumenter = new Instrumenter(tracer, tracerConfig)
  })

  afterEach(() => {
    const basedir = path.resolve(path.join(__dirname, 'node_modules'))

    Object.keys(require.cache)
      .filter(name => name.indexOf(basedir) !== -1)
      .forEach(name => {
        delete require.cache[name]
      })
  })

  describe('with integrations enabled', () => {
    beforeEach(() => {
      instrumenter.enable()
    })

    describe('use', () => {
      it('should allow configuring a plugin by name', () => {
        const config = { foo: 'bar' }

        instrumenter.use('express-mock', config)
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

      it('should reapply the require hook when called multiple times', () => {
        instrumenter.use('mysql-mock')
        instrumenter.use('express-mock')
        instrumenter.patch()

        require('express-mock')

        expect(integrations.express.patch).to.have.been.called
      })

      it('should handle errors', () => {
        expect(() => instrumenter.use()).not.to.throw()
      })

      it('should not patch modules with the wrong API', () => {
        integrations.express.patch = sinon.stub().throws(new Error())

        instrumenter.use('express-mock')

        const express = require('express-mock')

        expect(integrations.express.unpatch).to.have.been.calledWith(express)
      })

      it('should not patch modules with invalid files', () => {
        integrations.mysql[0].file = 'invalid.js'

        instrumenter.use('mysql-mock')

        require('mysql-mock')

        expect(integrations.mysql[0].patch).to.not.have.been.called
        expect(integrations.mysql[1].patch).to.not.have.been.called
      })

      it('should handle errors when unpatching', () => {
        integrations.mysql[1].unpatch = sinon.stub().throws(new Error())
        integrations.mysql[1].file = 'invalid.js'

        instrumenter.use('mysql-mock')

        require('mysql-mock')

        expect(integrations.mysql[0].patch).to.not.have.been.called
        expect(integrations.mysql[1].patch).to.not.have.been.called
      })

      it('should attempt to patch already loaded modules', () => {
        const express = require('express-mock')

        instrumenter.use('express-mock')

        expect(integrations.express.patch).to.have.been.called
        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', {})
      })

      it('should not patch twice already loaded modules', () => {
        require('express-mock')

        instrumenter.use('express-mock')

        require('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
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
        const Connection = require('mysql-mock/lib/connection')
        const Pool = require('mysql-mock/lib/pool')

        instrumenter.patch()

        const mysql = require('mysql-mock')

        expect(mysql).to.deep.equal({ name: 'mysql' })

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

      it('should remove the require hooks', () => {
        instrumenter.patch()
        instrumenter.unpatch()

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.called
      })

      it('should handle errors', () => {
        integrations.mysql[0].unpatch = sinon.stub().throws(new Error())
        instrumenter.patch()

        require('mysql-mock')

        expect(() => instrumenter.unpatch()).to.not.throw()
        expect(integrations.mysql[1].unpatch).to.have.been.called
      })
    })

    describe('wrap', () => {
      it('should wrap the method on the object', () => {
        const obj = { method: () => {} }
        const wrapper = () => {}

        instrumenter.wrap(obj, 'method', wrapper)

        expect(shimmer.massWrap).to.have.been.calledWith([obj], ['method'], wrapper)
      })

      it('should throw if the method does not exist', () => {
        const obj = {}
        const wrapper = () => {}

        expect(() => instrumenter.wrap(obj, 'method', wrapper)).to.throw()
      })
    })

    describe('unwrap', () => {
      it('should wrap the method on the object', () => {
        const obj = { method: () => {} }

        instrumenter.unwrap(obj, 'method')

        expect(shimmer.massUnwrap).to.have.been.calledWith([obj], ['method'])
      })
    })
  })

  describe('with integrations disabled', () => {
    beforeEach(() => {
      instrumenter.enable()
    })

    describe('use', () => {
      it('should still allow adding plugins manually by name', () => {
        instrumenter.use('express-mock')
        instrumenter.patch({ plugins: false })

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', {})
      })
    })

    describe('patch', () => {
      it('should not patch any module', () => {
        instrumenter.patch({ plugins: false })

        const express = require('express-mock')

        expect(integrations.express.patch).to.not.have.been.calledWith(express, 'tracer', {})
      })
    })
  })

  describe('with the instrumenter disabled', () => {
    describe('use', () => {
      it('should not patch modules when they are loaded when the tracer is disabled', () => {
        tracerConfig.enabled = false

        instrumenter.patch()

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.called
      })
    })

    describe('patch', () => {
      it('should not patch if the tracer is disabled', () => {
        tracerConfig.enabled = false

        instrumenter.use('express-mock')

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.called
      })
    })
  })
})
