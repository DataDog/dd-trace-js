'use strict'

const assert = require('node:assert/strict')

const { _extractModuleRootAndHandler, _extractModuleNameAndHandlerPath } = require('../../../src/lambda/runtime/ritm')

describe('runtime', () => {
  describe('ritm', () => {
    describe('_extractModuleRootAndHandler', () => {
      it('breaks nested module and handler correctly', () => {
        const fullHandler = './api/src/index.nested.handler'
        const [moduleRoot, handlerString] = _extractModuleRootAndHandler(fullHandler)

        const expectedModuleRoot = './api/src/'
        const expectedHandler = 'index.nested.handler'

        assert.strictEqual(moduleRoot, expectedModuleRoot)
        assert.strictEqual(handlerString, expectedHandler)
      })

      it('breaks module and handler correctly', () => {
        const fullHandler = './src/handler.handler'
        const [moduleRoot, handlerString] = _extractModuleRootAndHandler(fullHandler)

        const expectedModuleRoot = './src/'
        const expectedHandler = 'handler.handler'

        assert.strictEqual(moduleRoot, expectedModuleRoot)
        assert.strictEqual(handlerString, expectedHandler)
      })
    })

    describe('_extractModuleNameAndHandlerPath', () => {
      it('breaks module name and nested handler path correctly', () => {
        const handler = 'index.nested.handler'
        const [moduleName, handlerPath] = _extractModuleNameAndHandlerPath(handler)

        const expectedModuleName = 'index'
        const expectedHandlerPath = 'nested.handler'

        assert.strictEqual(moduleName, expectedModuleName)
        assert.strictEqual(handlerPath, expectedHandlerPath)
      })

      it('breaks module name and handler path correctly', () => {
        const handler = 'handler.handler'
        const [moduleName, handlerPath] = _extractModuleNameAndHandlerPath(handler)

        const expectedModuleName = 'handler'
        const expectedHandlerPath = 'handler'

        assert.strictEqual(moduleName, expectedModuleName)
        assert.strictEqual(handlerPath, expectedHandlerPath)
      })

      it('throws an error if the handler is malformed', () => {
        const handler = 'handler'
        assert.throws(() => _extractModuleNameAndHandlerPath(handler), Error, `Malformed handler name: ${handler}`)
      })
    })
  })
})
