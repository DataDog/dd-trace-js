'use strict'

const { assert } = require('chai')
const proxyquire = require('proxyquire')
const { CUSTOM_SECURE_MARK, COMMAND_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')
const { saveIastContext } = require('../../../../src/appsec/iast/iast-context')

const CUSTOM_COMMAND_INJECTION_MARK = CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK

describe('IAST Security Controls', () => {
  let securityControls, addSecureMark, iastContext

  before(() => {
    // fire up ritm
    require('../../../../src/plugin_manager')
  })

  beforeEach(() => {
    addSecureMark = sinon.stub().callsFake((iastContext, input) => input)

    iastContext = {}
    const context = {}

    securityControls = proxyquire('../../../../src/appsec/iast/security-controls', {
      '../taint-tracking/operations': {
        addSecureMark
      },
      '../../../../../datadog-core': {
        storage: {
          getStore: sinon.stub().returns(context)
        }
      }
    })

    saveIastContext(context, {}, iastContext)
  })

  afterEach(() => {
    securityControls.disable()
    sinon.restore()
  })

  describe('in custom libs', () => {
    it('should hook configured control for input_validator', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/custom_input_validator.js:validate'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { validate } = require('./resources/custom_input_validator')
      validate('input')

      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, 'input', CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should hook configured control for default sanitizer', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/sanitizer_default.js'
      securityControls.configure({ securityControlsConfiguration: conf })

      const sanitize = require('./resources/sanitizer_default')
      const result = sanitize('input')

      assert.equal(result, 'sanitized input')
      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should hook multiple methods', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom_input_validator.js:validate;SANITIZER:\
COMMAND_INJECTION:packages/dd-trace/test/appsec/iast/security-controls/resources\
/custom_input_validator.js:validateObject'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { validate, validateObject } = require('./resources/custom_input_validator')
      let result = validate('input')

      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)

      result = validateObject('another input')

      sinon.assert.calledTwice(addSecureMark)
      sinon.assert.calledWithExactly(addSecureMark.secondCall, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should hook configured control for input_validator with multiple inputs', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/custom_input_validator.js:validate'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { validate } = require('./resources/custom_input_validator')
      validate('input1', 'input2')

      sinon.assert.calledTwice(addSecureMark)
      sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input1', CUSTOM_COMMAND_INJECTION_MARK)
      sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input2', CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should hook configured control for sanitizer', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/sanitizer.js:sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { sanitize } = require('./resources/sanitizer')
      const result = sanitize('input')

      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)
    })
  })

  describe('object inputs or sanitized outputs', () => {
    it('should add marks for input string properties', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/custom_input_validator.js:validateObject'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { validateObject } = require('./resources/custom_input_validator')
      const result = validateObject({ input1: 'input1', nested: { input: 'input2' } })

      sinon.assert.calledTwice(addSecureMark)
      sinon.assert.calledWithExactly(addSecureMark.firstCall, iastContext, result.input1, CUSTOM_COMMAND_INJECTION_MARK)
      sinon.assert.calledWithExactly(addSecureMark.secondCall,
        iastContext, result.nested.input, CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should add marks for mixed input string properties', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/custom_input_validator.js:validateObject'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { validateObject } = require('./resources/custom_input_validator')
      const result = validateObject({ input1: 'input1' }, 'input3')

      sinon.assert.calledTwice(addSecureMark)
      sinon.assert.calledWithExactly(addSecureMark.firstCall, iastContext, result.input1, CUSTOM_COMMAND_INJECTION_MARK)
      sinon.assert.calledWithExactly(addSecureMark.secondCall,
        iastContext, 'input3', CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should add marks for sanitized object string properties', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/sanitizer.js:sanitizeObject'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { sanitizeObject } = require('./resources/sanitizer')
      const result = sanitizeObject({ output: 'output1', nested: { output: 'nested output' } })

      sinon.assert.calledTwice(addSecureMark)
      sinon.assert.calledWithExactly(addSecureMark.firstCall, iastContext, result.output, CUSTOM_COMMAND_INJECTION_MARK)
      sinon.assert.calledWithExactly(addSecureMark.secondCall, iastContext, result.nested.output,
        CUSTOM_COMMAND_INJECTION_MARK)
    })
  })

  describe('in nested objects', () => {
    it('should hook configured control for sanitizer in nested object', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/sanitizer.js:nested.sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { nested } = require('./resources/sanitizer')
      const result = nested.sanitize('input')

      assert.equal(result, 'sanitized input')
      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should not fail hook in incorrect nested object', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/sanitizer.js:incorrect.sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { nested } = require('./resources/sanitizer')
      const result = nested.sanitize('input')

      sinon.assert.notCalled(addSecureMark)
      assert.equal(result, 'sanitized input')
    })

    it('should not fail hook in incorrect nested object 2', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
  /security-controls/resources/sanitizer.js:nested.incorrect.sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { nested } = require('./resources/sanitizer')
      const result = nested.sanitize('input')

      sinon.assert.notCalled(addSecureMark)
      assert.equal(result, 'sanitized input')
    })
  })

  describe('in node_modules', () => {
    it('should hook node_module dependency', () => {
      const conf = 'SANITIZER:COMMAND_INJECTION:node_modules/sanitizer/index.js:sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { sanitize } = require('./resources/node_modules/sanitizer')
      const result = sanitize('input')

      assert.equal(result, 'sanitized input')
      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should hook transitive node_module dependency', () => {
      const conf = 'SANITIZER:COMMAND_INJECTION:node_modules/sanitizer/index.js:sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { sanitize } = require('./resources/node_modules/anotherlib/node_modules/sanitizer')
      const result = sanitize('input')

      assert.equal(result, 'sanitized input')
      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK)
    })

    it('should not fail with not found node_module dep', () => {
      const conf = 'SANITIZER:COMMAND_INJECTION:node_modules/not_loaded_sanitizer/index.js:sanitize'
      securityControls.configure({ securityControlsConfiguration: conf })

      const { sanitize } = require('./resources/node_modules/sanitizer')
      const result = sanitize('input')

      assert.equal(result, 'sanitized input')
      sinon.assert.notCalled(addSecureMark)
    })
  })
})
