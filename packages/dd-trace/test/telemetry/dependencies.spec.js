'use strict'

const t = require('tap')
require('../setup/core')

const proxyquire = require('proxyquire')
const path = require('path')
const dc = require('dc-polyfill')
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
const originalSetImmediate = global.setImmediate
t.test('dependencies', t => {
  t.test('start', t => {
    t.test('should subscribe', t => {
      const subscribe = sinon.stub()
      const dc = { channel () { return { subscribe } } }
      const dependencies = proxyquire('../../src/telemetry/dependencies', {
        'dc-polyfill': dc
      })

      dependencies.start()
      expect(subscribe).to.have.been.calledOnce
      t.end()
    })
    t.end()
  })

  t.test('on event', t => {
    const config = {}
    const application = 'test'
    const host = 'host'
    const basepathWithoutNodeModules = process.cwd().replace(/node_modules/g, 'nop')
    const fileURIWithoutNodeModules = 'file://c/Users/user/project'
    let dependencies
    let sendData
    let requirePackageJson
    let getRetryData
    let updateRetryData

    t.beforeEach(() => {
      requirePackageJson = sinon.stub()
      sendData = sinon.stub()
      getRetryData = sinon.stub()
      updateRetryData = sinon.stub()
      dependencies = proxyquire('../../src/telemetry/dependencies', {
        './index': { getRetryData, updateRetryData },
        './send-data': { sendData },
        '../require-package-json': requirePackageJson
      })
      global.setImmediate = function (callback) { callback() }

      dependencies.start(config, application, host, getRetryData, updateRetryData)

      // force first publish to load cached requires
      moduleLoadStartChannel.publish({})
    })

    t.afterEach(() => {
      dependencies.stop()
      sendData.reset()
      getRetryData.reset()
      updateRetryData.reset()
      global.setImmediate = originalSetImmediate
    })

    t.test('should not fail with invalid data', t => {
      moduleLoadStartChannel.publish(null)
      moduleLoadStartChannel.publish({})
      moduleLoadStartChannel.publish({ filename: 'filename' })
      moduleLoadStartChannel.publish({ request: 'request' })
      moduleLoadStartChannel.publish(undefined)
      moduleLoadStartChannel.publish()
      t.end()
    })

    t.test('should not call to sendData with core library', t => {
      moduleLoadStartChannel.publish({ request: 'crypto', filename: 'crypto' })
      expect(sendData).not.to.have.been.called
      t.end()
    })

    t.test('should not call to sendData without node_modules in path', t => {
      const filename = path.join(basepathWithoutNodeModules, 'custom.js')
      moduleLoadStartChannel.publish({ request: 'custom-module', filename })
      expect(sendData).not.to.have.been.called
      t.end()
    })

    t.test('should not call to sendData without node_modules in file URI', t => {
      const filename = [fileURIWithoutNodeModules, 'custom.js'].join('/')
      moduleLoadStartChannel.publish({ request: 'custom-module', filename })
      expect(sendData).not.to.have.been.called
      t.end()
    })

    t.test('should not call to sendData without node_modules in path when request does not come in message', t => {
      const filename = path.join(basepathWithoutNodeModules, 'custom.js')
      moduleLoadStartChannel.publish({ filename })
      expect(sendData).not.to.have.been.called
      t.end()
    })

    t.test('should not call to sendData without node_modules in path when request does not come in message', t => {
      const filename = [fileURIWithoutNodeModules, 'custom.js'].join('/')
      moduleLoadStartChannel.publish({ filename })
      expect(sendData).not.to.have.been.called
      t.end()
    })

    t.test('should not call to sendData without package.json', t => {
      const request = 'custom-module'
      requirePackageJson.callsFake(function () { throw new Error() })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).not.to.have.been.called
      t.end()
    })
    const requests = [
      '../index.js',
      `..${path.sep}index.js`,
      './index.js', `.${path.sep}index.js`,
      path.join(basepathWithoutNodeModules, 'index.js'),
      '/some/absolute/path/index.js']
    requests.forEach(request => {
      t.test(`should not call to sendData with file paths request: ${request}`, t => {
        requirePackageJson.returns({ version: '1.0.0' })
        const filename = path.join(basepathWithoutNodeModules, 'node_modules', 'custom-module', 'index.js')
        moduleLoadStartChannel.publish({ request, filename })
        expect(sendData).not.to.have.been.called
        t.end()
      })
    })

    t.test('should call sendData', t => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
      t.end()
    })

    t.test('should call sendData with file URI', t => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = [fileURIWithoutNodeModules, 'node_modules', request, 'index.js'].join('/')
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
      t.end()
    })

    t.test('should call sendData with computed request from file URI when it does not come in message', t => {
      const request = 'custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename = [fileURIWithoutNodeModules, 'node_modules', request, 'index.js'].join('/')
      moduleLoadStartChannel.publish({ filename })
      const expectedDependencies = {
        dependencies: [
          { name: request, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
      t.end()
    })

    t.test('should call sendData with computed request from file path when it does not come in message', t => {
      const request = 'custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename = [fileURIWithoutNodeModules, 'node_modules', request, 'index.js'].join('/')
      moduleLoadStartChannel.publish({ filename })
      const expectedDependencies = {
        dependencies: [
          { name: request, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
      t.end()
    })

    t.test(
      'should call sendData with computed request from filename with scope when it does not come in message',
      t => {
        const request = '@scope/custom-module'
        const packageVersion = '1.0.0'
        requirePackageJson.returns({ version: packageVersion })
        const filename = 'file:' + path.sep + path.sep +
          path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
        moduleLoadStartChannel.publish({ filename })
        const expectedDependencies = {
          dependencies: [
            { name: request, version: packageVersion }
          ]
        }
        expect(sendData)
          .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
        t.end()
      }
    )

    t.test('should only include one copy of each dependency, regardless of how many of its files are loaded', t => {
      const moduleName = 'custom-module'
      const packageVersion = '1.0.0'
      requirePackageJson.returns({ version: packageVersion })
      const filename1 = [fileURIWithoutNodeModules, 'node_modules', moduleName, 'index1.js'].join('/')
      const filename2 = [fileURIWithoutNodeModules, 'node_modules', moduleName, 'index2.js'].join('/')
      moduleLoadStartChannel.publish({ request: moduleName, filename: filename1 })
      moduleLoadStartChannel.publish({ request: moduleName, filename: filename2 })
      const expectedDependencies = {
        dependencies: [
          { name: moduleName, version: packageVersion }
        ]
      }
      expect(sendData)
        .to.have.been.calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
      t.end()
    })

    t.test('should include two dependencies when they are in different paths', t => {
      const moduleName = 'custom-module'
      const packageVersion = '1.0.0'
      const nestedPackageVersion = '0.5.0'
      const firstLevelDependency = [fileURIWithoutNodeModules, 'node_modules', moduleName, 'index1.js'].join('/')
      const nestedDependency =
        [fileURIWithoutNodeModules, 'node_modules', 'dependency', 'node_modules', moduleName, 'index1.js'].join('/')

      requirePackageJson.callsFake(function (dependencyPath) {
        if (dependencyPath.includes(path.join('node_modules', 'dependency', 'node_modules'))) {
          return { version: nestedPackageVersion }
        } else {
          return { version: packageVersion }
        }
      })

      moduleLoadStartChannel.publish({ request: moduleName, filename: firstLevelDependency })
      moduleLoadStartChannel.publish({ request: moduleName, filename: nestedDependency })

      const expectedDependencies1 = {
        dependencies: [
          { name: moduleName, version: packageVersion }
        ]
      }
      const expectedDependencies2 = {
        dependencies: [
          { name: moduleName, version: nestedPackageVersion }
        ]
      }
      expect(sendData).to.have.been.calledTwice

      expect(sendData.firstCall)
        .to.have.been.calledWith(config, application, host, 'app-dependencies-loaded', expectedDependencies1)

      expect(sendData.secondCall)
        .to.have.been.calledWith(config, application, host, 'app-dependencies-loaded', expectedDependencies2)
      t.end()
    })

    t.test(
      'should include only one dependency when they are in different paths but the version number is the same',
      t => {
        const moduleName = 'custom-module'
        const packageVersion = '1.0.0'
        const firstLevelDependency = [fileURIWithoutNodeModules, 'node_modules', moduleName, 'index1.js'].join('/')
        const nestedDependency =
          [fileURIWithoutNodeModules, 'node_modules', 'dependency', 'node_modules', moduleName, 'index1.js'].join('/')

        requirePackageJson.callsFake(function (dependencyPath) {
          if (dependencyPath.includes(path.join('node_modules', 'dependency', 'node_modules'))) {
            return { version: packageVersion }
          } else {
            return { version: packageVersion }
          }
        })

        moduleLoadStartChannel.publish({ request: moduleName, filename: firstLevelDependency })
        moduleLoadStartChannel.publish({ request: moduleName, filename: nestedDependency })

        const expectedDependencies = {
          dependencies: [
            { name: moduleName, version: packageVersion }
          ]
        }
        expect(sendData).to.have.been
          .calledOnceWith(config, application, host, 'app-dependencies-loaded', expectedDependencies)
        t.end()
      }
    )

    t.test('should call sendData only once with duplicated dependency', t => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename })
      moduleLoadStartChannel.publish({ request, filename })
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
      t.end()
    })

    t.test('should call sendData twice with more than 2000 dependencies', (t) => {
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
      for (let i = 0; i < 2200; i++) {
        const request = requestPrefix + i
        const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
        moduleLoadStartChannel.publish({ request, filename })
      }
      const interval = setInterval(() => {
        if (atLeastOneTimeout && timeouts.length === 0) {
          clearInterval(interval)
          expect(sendData).to.have.been.calledTwice
          t.end()
        }
      })
    })
    t.end()
  })

  t.test('with configuration', t => {
    const config = {
      telemetry: {
        dependencyCollection: false
      }
    }
    const application = 'test'
    const host = 'host'
    const basepathWithoutNodeModules = process.cwd().replace(/node_modules/g, 'nop')

    let dependencies
    let sendData
    let requirePackageJson
    let getRetryData
    let updateRetryData

    t.beforeEach(() => {
      requirePackageJson = sinon.stub()
      sendData = sinon.stub()
      getRetryData = sinon.stub()
      updateRetryData = sinon.stub()
      dependencies = proxyquire('../../src/telemetry/dependencies', {
        './index': { getRetryData, updateRetryData },
        './send-data': { sendData },
        '../require-package-json': requirePackageJson
      })
      global.setImmediate = function (callback) { callback() }

      dependencies.start(config, application, host, getRetryData, updateRetryData)

      // force first publish to load cached requires
      moduleLoadStartChannel.publish({}) // called once here
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename }) // called again here
    })

    t.afterEach(() => {
      dependencies.stop()
      sendData.reset()
      getRetryData.reset()
      updateRetryData.reset()
      global.setImmediate = originalSetImmediate
    })

    t.test('should not call sendData for modules not captured in the initial load', t => {
      setTimeout(() => {
        // using sendData.callCount wasn't working properly
        const timesCalledBeforeLazyLoad = sendData.getCalls().length

        const request = 'custom-module2'
        const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
        moduleLoadStartChannel.publish({ request, filename }) // should not be called here

        expect(sendData.getCalls().length).to.equal(timesCalledBeforeLazyLoad)
        t.end()
      }, 5) // simulate lazy-loaded dependency, small ms delay to be safe
    })
    t.end()
  })

  t.test('on failed request', t => {
    const config = {}
    const application = 'test'
    const host = 'host'
    const basepathWithoutNodeModules = process.cwd().replace(/node_modules/g, 'nop')
    let dependencies
    let sendData
    let requirePackageJson
    let capturedRequestType
    let getRetryData
    let updateRetryData

    t.beforeEach(() => {
      requirePackageJson = sinon.stub()
      sendData = (config, application, host, reqType, payload, cb = () => {}) => {
        capturedRequestType = reqType
        // Simulate an HTTP error by calling the callback with an error
        cb(new Error('HTTP request error'), {
          payload,
          reqType: 'app-integrations-change'
        })
      }
      getRetryData = sinon.stub()
      updateRetryData = sinon.stub()
      dependencies = proxyquire('../../src/telemetry/dependencies', {
        './send-data': { sendData },
        '../require-package-json': requirePackageJson
      })
      global.setImmediate = function (callback) { callback() }

      dependencies.start(config, application, host, getRetryData, updateRetryData)

      // force first publish to load cached requires
      moduleLoadStartChannel.publish({})
    })

    t.afterEach(() => {
      dependencies.stop()
      getRetryData.reset()
      updateRetryData.reset()
      global.setImmediate = originalSetImmediate
    })

    t.test('should update retry data', t => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename })
      // expect(getRetryData).to.have.been.calledOnce
      expect(capturedRequestType).to.equals('app-dependencies-loaded')
      // expect(sendData).to.have.been.calledOnce
      // expect(updateRetryData).to.have.been.calledOnce
      t.end()
    })

    t.test('should create batch request', t => {
      let request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      let filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename })
      expect(getRetryData).to.have.been.calledOnce
      expect(capturedRequestType).to.equals('app-dependencies-loaded')
      expect(updateRetryData).to.have.been.calledOnce

      getRetryData.returns({
        request_type: 'app-integrations-change',
        payload: {
          integrations: [{
            name: 'zoo1',
            enabled: true,
            auto_enabled: true
          }]
        }

      })

      request = 'even-more-custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      moduleLoadStartChannel.publish({ request, filename })
      expect(getRetryData).to.have.been.calledTwice
      expect(capturedRequestType).to.equals('message-batch')
      expect(updateRetryData).to.have.been.calledTwice
      t.end()
    })
    t.end()
  })
  t.end()
})
