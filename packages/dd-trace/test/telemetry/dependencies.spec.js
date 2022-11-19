'use strict'

require('../setup/core')

const proxyquire = require('proxyquire')
const path = require('path')
const dc = require('diagnostics_channel')
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
const originalSetImmediate = global.setImmediate
describe('dependencies', () => {
  describe('start', () => {
    it('should subscribe', () => {
      const subscribe = sinon.stub()
      const dc = { channel () { return { subscribe } } }
      const dependencies = proxyquire('../../src/telemetry/dependencies', {
        'diagnostics_channel': dc
      })
      dependencies.start()
      expect(subscribe).to.have.been.calledOnce
    })
  })
  describe('on event', () => {
    const config = {}
    const application = 'test'
    const host = 'host'
    const basepathWithoutNodeModules = process.cwd().replace(/node_modules/g, 'nop')
    const fileURIWithoutNodeModules = 'file://c/Users/user/project'
    let dependencies
    let sendData
    let requirePackageJson

    beforeEach(() => {
      requirePackageJson = sinon.stub()
      sendData = sinon.stub()
      dependencies = proxyquire('../../src/telemetry/dependencies', {
        './send-data': { sendData },
        '../require-package-json': requirePackageJson
      })
      global.setImmediate = function (callback) { callback() }
    })

    afterEach(() => {
      dependencies.stop()
      global.setImmediate = originalSetImmediate
    })

    it('should not fail with invalid data', () => {
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish(null)
      moduleLoadStartChannel.publish({})
      moduleLoadStartChannel.publish({ filename: 'filename' })
      moduleLoadStartChannel.publish({ request: 'request' })
      moduleLoadStartChannel.publish(undefined)
      moduleLoadStartChannel.publish()
    })

    it('should not call to sendData with core library', () => {
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request: 'crypto', filename: 'crypto' })
      expect(sendData).not.to.have.been.called
    })

    it('should not call to sendData without node_modules in path', () => {
      const filename = path.join(basepathWithoutNodeModules, 'custom.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request: 'custom-module', filename })
      expect(sendData).not.to.have.been.called
    })

    it('should not call to sendData without node_modules in file URI', () => {
      const filename = [fileURIWithoutNodeModules, 'custom.js'].join('/')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request: 'custom-module', filename })
      expect(sendData).not.to.have.been.called
    })

    it('should not call to sendData without node_modules in path when request does not come in message', () => {
      const filename = path.join(basepathWithoutNodeModules, 'custom.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ filename })
      expect(sendData).not.to.have.been.called
    })

    it('should not call to sendData without node_modules in path when request does not come in message', () => {
      const filename = [fileURIWithoutNodeModules, 'custom.js'].join('/')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ filename })
      expect(sendData).not.to.have.been.called
    })

    it('should not call to sendData without package.json', () => {
      const request = 'custom-module'
      requirePackageJson.callsFake(function () { throw new Error() })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).not.to.have.been.called
    })

    it('should call sendData', () => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
    })

    it('should call sendData with file URI', () => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = [fileURIWithoutNodeModules, 'node_modules', request, 'index.js'].join('/')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
    })

    it('should call sendData with computed request from file URI when it does not come in message', () => {
      const request = 'custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename = [fileURIWithoutNodeModules, 'node_modules', request, 'index.js'].join('/')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ filename })
      const expectedDependencies = {
        dependencies: [
          { name: request, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
    })

    it('should call sendData with computed request from file path when it does not come in message', () => {
      const request = 'custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename = [fileURIWithoutNodeModules, 'node_modules', request, 'index.js'].join('/')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ filename })
      const expectedDependencies = {
        dependencies: [
          { name: request, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
    })

    it('should call sendData with computed request from filename with scope when it does not come in message', () => {
      const request = '@scope/custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename = 'file:' + path.sep + path.sep +
        path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ filename })
      const expectedDependencies = {
        dependencies: [
          { name: request, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
    })

    it('should only include one copy of each dependency, regardless of how many of its files are loaded', () => {
      const moduleName = 'custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename1 = [fileURIWithoutNodeModules, 'node_modules', moduleName, 'index1.js'].join('/')
      const filename2 = [fileURIWithoutNodeModules, 'node_modules', moduleName, 'index2.js'].join('/')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request: moduleName, filename: filename1 })
      moduleLoadStartChannel.publish({ request: moduleName, filename: filename2 })
      const expectedDependencies = {
        dependencies: [
          { name: moduleName, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
    })

    it('should call sendData only once with duplicated dependency', () => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request, filename })
      moduleLoadStartChannel.publish({ request, filename })
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
    })

    it('should call sendData twice with more than 1000 dependencies', (done) => {
      dependencies.start(config, application, host)
      const requestPrefix = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const timeouts = []
      let atLeastOneTimeout = false
      global.setImmediate = function (callback) {
        atLeastOneTimeout = true
        const timeout = originalSetImmediate(function () {
          const cbResult = callback.apply(this, arguments)
          timeouts.splice(timeouts.indexOf(timeout), 1)
          return cbResult
        })
        timeouts.push(timeout)
        return timeout
      }
      for (let i = 0; i < 1200; i++) {
        const request = requestPrefix + i
        const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
        moduleLoadStartChannel.publish({ request, filename })
      }
      const interval = setInterval(() => {
        if (atLeastOneTimeout && timeouts.length === 0) {
          clearInterval(interval)
          expect(sendData).to.have.been.calledTwice
          done()
        }
      })
    })
  })
})
