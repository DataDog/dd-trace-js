'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

const { varySandbox } = require('./helpers')

describe('varySandbox', () => {
  beforeEach(() => {
    sinon.stub(global, 'before')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('creates every default export form', () => {
    assert.deepStrictEqual(varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: true,
      namedExports: [],
    }), {
      default: 'logger-default.mjs',
      'default-as-named': 'logger-default-as-named.mjs',
      'default-from-namespace': 'logger-default-from-namespace.mjs',
    })
  })

  it('creates every direct named export form', () => {
    assert.deepStrictEqual(varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: true,
      namedExports: ['createLogger'],
      namedExportBinding: 'direct',
    }), {
      default: 'logger-default.mjs',
      'default-as-named': 'logger-default-as-named.mjs',
      'default-from-namespace': 'logger-default-from-namespace.mjs',
      named: 'logger-named.mjs',
      'named-from-namespace': 'logger-named-from-namespace.mjs',
    })
  })

  it('creates every namespace-shaped named export form', () => {
    assert.deepStrictEqual(varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: true,
      namedExports: ['createLogger', 'levels'],
      namedExportBinding: 'namespace',
    }), {
      default: 'logger-default.mjs',
      'default-as-named': 'logger-default-as-named.mjs',
      'default-from-namespace': 'logger-default-from-namespace.mjs',
      named: 'logger-named.mjs',
      'named-from-namespace': 'logger-named-from-namespace.mjs',
    })
  })

  it('creates named-only forms', () => {
    assert.deepStrictEqual(varySandbox('logger.mjs', {
      bindingName: 'Logger',
      packageName: 'logger',
      defaultExport: false,
      namedExports: ['Logger'],
      namedExportBinding: 'direct',
    }), {
      named: 'logger-named.mjs',
      'named-from-namespace': 'logger-named-from-namespace.mjs',
    })
  })

  it('creates separately bound named export forms', () => {
    assert.deepStrictEqual(varySandbox('logger.mjs', {
      bindingName: 'loggerModule',
      packageName: 'logger',
      defaultExport: false,
      namedExports: ['createLogger', 'levels'],
      namedExportBinding: 'destructure',
    }), {
      named: 'logger-named.mjs',
      'named-from-namespace': 'logger-named-from-namespace.mjs',
    })
  })

  it('rejects an impossible export configuration', () => {
    assert.throws(() => varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: false,
      namedExports: [],
    }), {
      message: 'At least one default or named export is required',
    })
  })

  it('requires a named export binding style', () => {
    assert.throws(() => varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: false,
      namedExports: ['createLogger'],
    }), {
      message: 'Named exports require a binding style',
    })
  })

  it('rejects an unknown named export binding style', () => {
    assert.throws(() => varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: false,
      namedExports: ['createLogger'],
      namedExportBinding: 'unknown',
    }), {
      message: 'Unknown named export binding style: unknown',
    })
  })

  it('rejects multiple direct named exports', () => {
    assert.throws(() => varySandbox('logger.mjs', {
      bindingName: 'logger',
      packageName: 'logger',
      defaultExport: false,
      namedExports: ['Logger', 'levels'],
      namedExportBinding: 'direct',
    }), {
      message: 'Direct named export bindings require exactly one export',
    })
  })
})
