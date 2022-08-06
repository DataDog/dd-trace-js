const proxyquire = require('proxyquire')
const path = require('path')
const dc = require('diagnostics_channel')
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
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
    let originalSetTimeout
    const config = {}
    const application = 'test'
    const host = 'host'
    const basepathWithoutNodeModules = process.cwd().replace(/node_modules/g, 'nop')
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
      originalSetTimeout = setTimeout
      global.setTimeout = function (callback) { callback() }
    })

    afterEach(() => {
      global.setTimeout = originalSetTimeout
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

    it('should not call to sendData node_modules in path', () => {
      const filename = path.join(basepathWithoutNodeModules, 'custom.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request: 'custom-module', filename })
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

    it('should call sendData with file:// format', () => {
      const request = 'custom-module'
      requirePackageJson.returns({ version: '1.0.0' })
      const filename = 'file:' + path.sep + path.sep +
        path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
      dependencies.start(config, application, host)
      moduleLoadStartChannel.publish({ request, filename })
      expect(sendData).to.have.been.calledOnce
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
      global.setTimeout = function (callback) {
        return originalSetTimeout(callback)
      }
      for (let i = 0; i < 1200; i++) {
        const request = requestPrefix + i
        const filename = path.join(basepathWithoutNodeModules, 'node_modules', request, 'index.js')
        moduleLoadStartChannel.publish({ request, filename })
      }
      originalSetTimeout(() => {
        expect(sendData).to.have.been.calledTwice
        done()
      }, 5)
    })
  })
})
