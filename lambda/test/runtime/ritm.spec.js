'use strict'

const { expect } = require('chai')
const { _extractModuleRootAndHandler, _extractModuleNameAndHandlerPath } = require('../../src/runtime/ritm')

describe('runtime', () => {
  describe('ritm', () => {
    describe('_extractModuleRootAndHandler', () => {
      it('breaks nested module and handler correctly', () => {
        const fullHandler = './api/src/index.nested.handler'
        const [moduleRoot, handlerString] = _extractModuleRootAndHandler(fullHandler)

        const expectedModuleRoot = './api/src/'
        const expectedHandler = 'index.nested.handler'

        expect(moduleRoot).to.equal(expectedModuleRoot)
        expect(handlerString).to.equal(expectedHandler)
      })

      it('breaks module and handler correctly', () => {
        const fullHandler = './src/handler.handler'
        const [moduleRoot, handlerString] = _extractModuleRootAndHandler(fullHandler)

        const expectedModuleRoot = './src/'
        const expectedHandler = 'handler.handler'

        expect(moduleRoot).to.equal(expectedModuleRoot)
        expect(handlerString).to.equal(expectedHandler)
      })
    })

    describe('_extractModuleNameAndHandlerPath', () => {
      it('breaks module name and nested handler path correctly', () => {
        const handler = 'index.nested.handler'
        const [moduleName, handlerPath] = _extractModuleNameAndHandlerPath(handler)

        const expectedModuleName = 'index'
        const expectedHandlerPath = 'nested.handler'

        expect(moduleName).to.equal(expectedModuleName)
        expect(handlerPath).to.equal(expectedHandlerPath)
      })

      it('breaks module name and handler path correctly', () => {
        const handler = 'handler.handler'
        const [moduleName, handlerPath] = _extractModuleNameAndHandlerPath(handler)

        const expectedModuleName = 'handler'
        const expectedHandlerPath = 'handler'

        expect(moduleName).to.equal(expectedModuleName)
        expect(handlerPath).to.equal(expectedHandlerPath)
      })
    })
  })
})
