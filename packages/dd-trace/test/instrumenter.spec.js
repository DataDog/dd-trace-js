'use strict'

require('./setup/core')

/* eslint-disable import/no-extraneous-dependencies */

const proxyquire = require('proxyquire')
const path = require('path')
const { expect } = require('chai')
const ritm = require('../src/ritm')

describe('Instrumenter', () => {
  let Instrumenter
  let instrumenter
  let integrations
  let tracer
  let telemetry

  before(() => {
    process.env.DD_TRACE_DISABLED_PLUGINS = 'mocha'
  })

  after(() => {
    delete process.env.DD_TRACE_DISABLED_PLUGINS
  })

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
      ],
      other: {
        name: 'other',
        versions: ['1.x'],
        patch: sinon.stub().returns('replacement')
      }
    }

    telemetry = {
      updateIntegrations: sinon.spy()
    }

    Instrumenter = proxyquire('../src/instrumenter', {
      './plugins': {
        'http': integrations.http,
        'express-mock': integrations.express,
        'mysql-mock': integrations.mysql,
        'other': integrations.other
      },
      '../../datadog-plugin-http/src': integrations.http,
      '../../datadog-plugin-express-mock/src': integrations.express,
      '../../datadog-plugin-mysql-mock/src': integrations.mysql,
      '../../datadog-plugin-other/src': integrations.other,
      './telemetry': telemetry
    })

    instrumenter = new Instrumenter(tracer)
  })

  afterEach(() => {
    const basedir = path.resolve(path.join(__dirname, 'node_modules'))

    instrumenter.disable()

    Object.keys(require.cache)
      .filter(name => name.indexOf(basedir) !== -1)
      .forEach(name => {
        delete require.cache[name]
      })
    ritm.reset()
  })

  describe('with integrations enabled', () => {
    beforeEach(() => {
      instrumenter.enable()
    })

    describe('use', () => {
      it('should allow configuring a plugin by name', () => {
        const config = { foo: 'bar' }

        instrumenter.use('express-mock', config)
        instrumenter.enable()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', config)
      })

      it('should default to an empty plugin configuration', () => {
        instrumenter.use('express-mock')
        instrumenter.enable()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
        expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {})
      })

      it('should reapply the require hook when called multiple times', () => {
        instrumenter.use('mysql-mock')
        instrumenter.use('express-mock')
        instrumenter.enable()

        require('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
      })

      it('should handle errors', () => {
        expect(() => instrumenter.use()).not.to.throw()
      })

      it('should not patch modules with the wrong API', () => {
        integrations.express.patch = sinon.stub().throws(new Error())

        instrumenter.use('express-mock')

        const express = require('express-mock')

        expect(integrations.express.unpatch).to.have.been.calledOnce
        expect(integrations.express.unpatch).to.have.been.calledWith(express)
      })

      it('should not patch using instrumentations with invalid files', () => {
        integrations.mysql[0].file = 'invalid.js'

        instrumenter.use('mysql-mock')

        require('mysql-mock')

        expect(integrations.mysql[0].patch).to.not.have.been.called
        expect(integrations.mysql[1].patch).to.have.been.called
      })

      it('should handle errors when unpatching', () => {
        integrations.mysql[1].unpatch = sinon.stub().throws(new Error())

        instrumenter.use('mysql-mock')

        require('mysql-mock')

        instrumenter.unpatch(integrations.mysql[1])

        expect(integrations.mysql[1].unpatch).to.have.been.called
      })

      it('should attempt to patch already loaded modules', () => {
        const express = require('express-mock')

        instrumenter.use('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
        expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {})
      })

      it('should not patch twice already loaded modules', () => {
        require('express-mock')

        instrumenter.use('express-mock')

        require('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
      })

      it('should not patch disabled plugins', () => {
        instrumenter.use('express-mock', { enabled: false })

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.calledOnce
      })

      it('should not patch disabled plugins using shorthand', () => {
        instrumenter.use('express-mock', false)

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.calledOnce
      })

      it('should patch modules without declared entrypoint', () => {
        instrumenter.use('other', true)
        require('other')

        expect(integrations.other.patch).to.have.been.calledOnce
      })

      it('should not interfere with userland modules masking core modules', () => {
        expect(require('http2/foo.js')).to.equal('Hello, World!')
      })

      it('should call updateIntegrations on telemetry', () => {
        instrumenter.use('express-mock')

        expect(telemetry.updateIntegrations).to.have.been.called
      })
    })

    describe('enable', () => {
      it('should patch modules from node_modules when they are loaded', () => {
        instrumenter.enable()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledOnce
        expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {})
      })

      it('should only patch a module if its version is supported by the plugin ', () => {
        integrations.express.versions = ['^3.0.0']
        instrumenter.enable()

        const express = require('express-mock')

        expect(integrations.express.patch).to.not.have.been.calledWithMatch(express, 'tracer', {})
      })

      it('should patch native modules when they are loaded', () => {
        instrumenter.enable()

        const http = require('http')

        expect(integrations.http.patch).to.have.been.calledOnce
        expect(integrations.http.patch).to.have.been.calledWithMatch(http, 'tracer', {})
      })

      it('should support patching multiple files', () => {
        const Connection = require('mysql-mock/lib/connection')
        const Pool = require('mysql-mock/lib/pool')

        instrumenter.enable()

        const mysql = require('mysql-mock')

        expect(mysql).to.deep.equal({ name: 'mysql' })

        expect(integrations.mysql[0].patch).to.have.been.calledOnce
        expect(integrations.mysql[1].patch).to.have.been.calledOnce
        expect(integrations.mysql[0].patch).to.have.been.calledWithMatch(Connection, 'tracer', {})
        expect(integrations.mysql[1].patch).to.have.been.calledWithMatch(Pool, 'tracer', {})
      })

      it('should support patching multiple modules with different files', () => {
        integrations.mysql[1].name = '@mysql/mock'
        integrations.mysql[1].file = 'invalid.js'

        const Connection = require('mysql-mock/lib/connection')

        instrumenter.enable()

        const mysql = require('mysql-mock')

        expect(mysql).to.deep.equal({ name: 'mysql' })

        expect(integrations.mysql[0].patch).to.have.been.calledOnce
        expect(integrations.mysql[0].patch).to.have.been.calledWithMatch(Connection, 'tracer', {})
      })

      it('should replace the module exports with the return value of the plugin', () => {
        instrumenter.enable()

        const other = require('other')

        expect(other).to.equal('replacement')
      })
    })

    describe('disable', () => {
      it('should unpatch patched modules', () => {
        instrumenter.enable()

        const express = require('express-mock')

        instrumenter.disable()

        expect(integrations.express.unpatch).to.have.been.calledOnce
        expect(integrations.express.unpatch).to.have.been.calledWith(express, tracer)
      })

      it('should remove the require hooks', () => {
        instrumenter.enable()
        instrumenter.disable()

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.called
      })

      it('should handle errors', () => {
        integrations.mysql[0].unpatch = sinon.stub().throws(new Error())
        instrumenter.enable()

        require('mysql-mock')

        expect(() => instrumenter.disable()).to.not.throw()
        expect(integrations.mysql[1].unpatch).to.have.been.calledOnce
        expect(integrations.mysql[1].unpatch).to.have.been.called
      })
    })

    describe('wrap', () => {
      it('should wrap the method on the object', () => {
        const method = () => {}
        const obj = { method }
        const wrapper = sinon.stub().returns(() => 'test')

        instrumenter.wrap(obj, 'method', wrapper)

        expect(wrapper).to.have.been.calledWith(method)
        expect(obj.method()).to.equal('test')
      })

      it('should preserve symbols on the method', () => {
        const sym = Symbol('foo')
        const obj = { method: () => {} }
        const wrapper = () => () => {}

        obj.method[sym] = 'bar'

        instrumenter.wrap(obj, 'method', wrapper)

        expect(obj.method).to.have.property(sym, 'bar')
      })

      it('should override existing symbols on the shim', () => {
        const sym = Symbol('foo')
        const obj = { method: () => {} }
        const shim = () => {}
        const wrapper = () => shim

        shim[sym] = 'override'
        obj.method[sym] = 'bar'

        instrumenter.wrap(obj, 'method', wrapper)

        expect(obj.method).to.have.property(sym, 'bar')
      })

      it('should throw if the method does not exist', () => {
        const obj = {}
        const wrapper = () => {}

        expect(() => instrumenter.wrap(obj, 'method', wrapper)).to.throw()
      })
    })

    describe('unwrap', () => {
      it('should wrap the method on the object', () => {
        const obj = { method: () => 'foo' }
        const wrapper = () => () => 'bar'

        instrumenter.wrap(obj, 'method', wrapper)
        instrumenter.unwrap(obj, 'method')

        expect(obj.method()).to.equal('foo')
      })
    })

    describe('wrapExport', () => {
      it('should wrap the exported function', () => {
        const fn = () => 'foo'
        const wrapper = () => fn() + 'bar'
        const shim = instrumenter.wrapExport(fn, wrapper)

        expect(shim).to.not.equal(fn)
        expect(shim()).to.equal('foobar')
      })
    })

    describe('unwrapExport', () => {
      it('should unwrap the exported function', () => {
        const fn = () => 'foo'
        const wrapper = () => fn() + 'bar'
        const shim = instrumenter.wrapExport(fn, wrapper)

        instrumenter.unwrapExport(shim)

        expect(shim()).to.equal('foo')
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
        instrumenter.enable({ plugins: false })

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {})
      })
    })
  })

  describe('with service mapping', () => {
    it('should change the service name in plugin config', () => {
      instrumenter.enable({ serviceMapping: { 'express-mock': 'something-else' } })

      const express = require('express-mock')

      expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {
        service: 'something-else'
      })
    })

    it('should defer to programmatic plugin config', () => {
      instrumenter.enable({ serviceMapping: { 'express-mock': 'something-else' } })
      instrumenter.use('express-mock', {
        service: 'something-else-entirely'
      })

      const express = require('express-mock')

      expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {
        service: 'something-else-entirely'
      })
    })
  })

  describe('with the instrumenter disabled', () => {
    describe('use', () => {
      it('should not patch if the tracer is disabled', () => {
        instrumenter.use('express-mock')

        require('express-mock')

        expect(integrations.express.patch).to.not.have.been.called
      })
    })

    describe('enable', () => {
      it('should attempt to patch already loaded modules', () => {
        const express = require('express-mock')

        instrumenter.enable()

        expect(integrations.express.patch).to.have.been.called
        expect(integrations.express.patch).to.have.been.calledWithMatch(express, 'tracer', {})
      })
    })
  })

  describe('with plugins configured via DD_TRACE_<INTEGRATION>', () => {
    beforeEach(() => {
      Instrumenter = proxyquire('../src/instrumenter', {
        './plugins': {
          'mysql-mock': integrations.mysql
        },
        '../../datadog-plugin-mysql-mock/src': integrations.mysql
      })
    })

    afterEach(() => {
      delete process.env.DD_TRACE_MYSQL_MOCK_ENABLED
    })

    it('should use _ENABLED', () => {
      instrumenter = new Instrumenter(tracer)
      process.env.DD_TRACE_MYSQL_MOCK_ENABLED = false
      instrumenter.enable()
      const plugins = [...instrumenter._plugins.values()]
      expect(plugins[0].name).to.equal('mysql-mock')
      expect(plugins[0].config.enabled).to.equal(false)
    })
  })

  describe('with plugins disabled via DD_TRACE_DISABLED_PLUGINS environment variable', () => {
    beforeEach(() => {
      process.env.DD_TRACE_DISABLED_PLUGINS = 'http,mysql-mock'

      Instrumenter = proxyquire('../src/instrumenter', {
        './plugins': {
          'http': integrations.http,
          'express-mock': integrations.express,
          'mysql-mock': integrations.mysql,
          'other': integrations.other
        },
        '../../datadog-plugin-http/src': integrations.http,
        '../../datadog-plugin-express-mock/src': integrations.express,
        '../../datadog-plugin-mysql-mock/src': integrations.mysql,
        '../../datadog-plugin-other/src': integrations.other
      })

      instrumenter = new Instrumenter(tracer)
    })

    afterEach(() => {
      delete process.env.DD_TRACE_DISABLED_PLUGINS
    })

    describe('enable', () => {
      it('should not patch plugins disabled from environnment variable configuration option', () => {
        instrumenter.enable()

        require('http')
        require('mysql-mock')

        expect(integrations.http.patch).to.not.have.been.called
        expect(integrations.mysql[0].patch).to.not.have.been.called
        expect(integrations.mysql[1].patch).to.not.have.been.called
      })

      it('should patch plugins not disabled by environnment variable configuration option', () => {
        const configDefault = {}
        instrumenter.enable()

        const express = require('express-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', configDefault)
        expect(process.env.DD_TRACE_DISABLED_PLUGINS.indexOf('express-mock')).to.equal(-1)
      })

      it('should not patch plugins called by .use that have been disabled by environment variable', () => {
        const configDefault = {}

        instrumenter.use('http', configDefault)
        instrumenter.use('mysql-mock', configDefault)
        instrumenter.use('express-mock', configDefault)
        instrumenter.enable()

        const express = require('express-mock')
        require('http')
        require('mysql-mock')

        expect(integrations.express.patch).to.have.been.calledWith(express, 'tracer', configDefault)
        expect(integrations.http.patch).to.not.have.been.called
        expect(integrations.mysql[0].patch).to.not.have.been.called
        expect(integrations.mysql[1].patch).to.not.have.been.called
      })
    })
  })
})
