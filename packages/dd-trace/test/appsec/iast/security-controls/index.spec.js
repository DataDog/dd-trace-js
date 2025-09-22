'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const { CUSTOM_SECURE_MARK, COMMAND_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')
const { saveIastContext } = require('../../../../src/appsec/iast/iast-context')

const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

const CUSTOM_COMMAND_INJECTION_MARK = CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK

describe('IAST Security Controls', () => {
  let securityControls, addSecureMark, iastContext

  describe('configure', () => {
    let controls, parse, startChSubscribe, endChSubscribe

    beforeEach(() => {
      controls = new Map()
      parse = sinon.stub().returns(controls)
      startChSubscribe = sinon.stub()
      endChSubscribe = sinon.stub()

      const channels = {
        'dd-trace:moduleLoadStart': {
          subscribe: startChSubscribe
        },
        'dd-trace:moduleLoadEnd': {
          subscribe: endChSubscribe
        }
      }

      securityControls = proxyquire('../../../../src/appsec/iast/security-controls', {
        'dc-polyfill': {
          channel: name => channels[name]
        },
        './parser': {
          parse
        }
      })
    })

    afterEach(() => {
      securityControls.disable()
    })

    it('should call parse and subscribe to moduleLoad channels', () => {
      controls.set('sanitizer.js', {})

      const securityControlsConfiguration = 'SANITIZER:CODE_INJECTION:sanitizer.js:sanitize'
      securityControls.configure({ securityControlsConfiguration })

      sinon.assert.calledWithExactly(parse, securityControlsConfiguration)

      sinon.assert.calledOnce(startChSubscribe)
      sinon.assert.calledOnce(endChSubscribe)
    })

    it('should call parse and not subscribe to moduleLoad channels', () => {
      const securityControlsConfiguration = 'invalid_config'
      securityControls.configure({ securityControlsConfiguration })

      sinon.assert.calledWithExactly(parse, securityControlsConfiguration)

      sinon.assert.notCalled(startChSubscribe)
      sinon.assert.notCalled(endChSubscribe)
    })
  })

  describe('hooks', () => {
    beforeEach(() => {
      addSecureMark = sinon.stub().callsFake((iastContext, input) => input)

      iastContext = {}
      const context = {}

      securityControls = proxyquire('../../../../src/appsec/iast/security-controls', {
        '../taint-tracking/operations': {
          addSecureMark
        },
        '../../../../../datadog-core': {
          storage: () => {
            return {
              getStore: sinon.stub().returns(context)
            }
          }
        }
      })

      saveIastContext(context, {}, iastContext)
    })

    afterEach(() => {
      securityControls.disable()
      sinon.restore()
    })

    function requireAndPublish (moduleName) {
      const filename = require.resolve(moduleName)
      let module = require(moduleName)

      const payload = { filename, module }
      moduleLoadEndChannel.publish(payload)
      module = payload.module
      return module
    }

    it('should hook a module only once', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate'
      securityControls.configure({ securityControlsConfiguration: conf })

      requireAndPublish('./resources/custom-input-validator')

      const { validate } = requireAndPublish('./resources/custom-input-validator')
      validate('input')

      sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, 'input', CUSTOM_COMMAND_INJECTION_MARK, false)
    })

    describe('in custom libs', () => {
      it('should hook configured control for input_validator', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validate } = requireAndPublish('./resources/custom-input-validator')
        validate('input')

        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, 'input', CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should hook configured control for default sanitizer', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer-default.js'
        securityControls.configure({ securityControlsConfiguration: conf })

        const sanitize = requireAndPublish('./resources/sanitizer-default')
        const result = sanitize('input')

        assert.equal(result, 'sanitized input')
        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, true)
      })

      it('should hook multiple methods', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate;INPUT_VALIDATOR:\
COMMAND_INJECTION:packages/dd-trace/test/appsec/iast/security-controls/resources\
/custom-input-validator.js:validateObject'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validate, validateObject } = requireAndPublish('./resources/custom-input-validator')
        let result = validate('input')

        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, false)

        result = validateObject('another input')

        sinon.assert.calledTwice(addSecureMark)
        sinon.assert.calledWithExactly(addSecureMark.secondCall,
          iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should hook configured control for input_validator with multiple inputs', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validate } = requireAndPublish('./resources/custom-input-validator')
        validate('input1', 'input2')

        sinon.assert.calledTwice(addSecureMark)
        sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input1', CUSTOM_COMMAND_INJECTION_MARK, false)
        sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input2', CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should hook configured control for input_validator with multiple inputs marking one parameter', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate:1'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validate } = requireAndPublish('./resources/custom-input-validator')
        validate('input1', 'input2')

        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, 'input2', CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should hook configured control for input_validator with multiple inputs marking multiple parameter', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate:1,3'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validate } = requireAndPublish('./resources/custom-input-validator')
        validate('input1', 'input2', 'input3', 'input4')

        sinon.assert.calledTwice(addSecureMark)
        sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input2', CUSTOM_COMMAND_INJECTION_MARK, false)
        sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input4', CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should hook configured control for input_validator with invalid parameter', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validate:42'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validate } = requireAndPublish('./resources/custom-input-validator')
        validate('input1')

        sinon.assert.notCalled(addSecureMark)
      })

      it('should hook configured control for sanitizer', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { sanitize } = requireAndPublish('./resources/sanitizer')
        const result = sanitize('input')

        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, true)
      })
    })

    describe('object inputs or sanitized outputs', () => {
      it('should add marks for input string properties', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validateObject'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validateObject } = requireAndPublish('./resources/custom-input-validator')
        const result = validateObject({ input1: 'input1', nested: { input: 'input2' } })

        sinon.assert.calledTwice(addSecureMark)
        sinon.assert.calledWithExactly(addSecureMark.firstCall,
          iastContext, result.input1, CUSTOM_COMMAND_INJECTION_MARK, false)
        sinon.assert.calledWithExactly(addSecureMark.secondCall,
          iastContext, result.nested.input, CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should add marks for mixed input string properties', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom-input-validator.js:validateObject'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { validateObject } = requireAndPublish('./resources/custom-input-validator')
        const result = validateObject({ input1: 'input1' }, 'input3')

        sinon.assert.calledTwice(addSecureMark)
        sinon.assert.calledWithExactly(addSecureMark.firstCall,
          iastContext, result.input1, CUSTOM_COMMAND_INJECTION_MARK, false)
        sinon.assert.calledWithExactly(addSecureMark.secondCall,
          iastContext, 'input3', CUSTOM_COMMAND_INJECTION_MARK, false)
      })

      it('should add marks for sanitized object string properties', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:sanitizeObject'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { sanitizeObject } = requireAndPublish('./resources/sanitizer')
        const result = sanitizeObject({ output: 'output1', nested: { output: 'nested output' } })

        sinon.assert.calledTwice(addSecureMark)
        sinon.assert.calledWithExactly(addSecureMark.firstCall,
          iastContext, result.output, CUSTOM_COMMAND_INJECTION_MARK, true)
        sinon.assert.calledWithExactly(addSecureMark.secondCall,
          iastContext, result.nested.output, CUSTOM_COMMAND_INJECTION_MARK, true)
      })
    })

    describe('in nested objects', () => {
      it('should hook configured control for sanitizer in nested object', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:nested.sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { nested } = requireAndPublish('./resources/sanitizer')
        const result = nested.sanitize('input')

        assert.equal(result, 'sanitized input')
        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, true)
      })

      it('should not fail hook in incorrect nested object', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:incorrect.sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { nested } = requireAndPublish('./resources/sanitizer')
        const result = nested.sanitize('input')

        sinon.assert.notCalled(addSecureMark)
        assert.equal(result, 'sanitized input')
      })

      it('should not fail hook in incorrect nested object 2', () => {
        // eslint-disable-next-line no-multi-str
        const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:nested.incorrect.sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { nested } = requireAndPublish('./resources/sanitizer')
        const result = nested.sanitize('input')

        sinon.assert.notCalled(addSecureMark)
        assert.equal(result, 'sanitized input')
      })
    })

    describe('in node_modules', () => {
      it('should hook node_module dependency', () => {
        const conf = 'SANITIZER:COMMAND_INJECTION:node_modules/sanitizer/index.js:sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { sanitize } = requireAndPublish('./resources/node_modules/sanitizer')
        const result = sanitize('input')

        assert.equal(result, 'sanitized input')
        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, true)
      })

      it('should hook transitive node_module dependency', () => {
        const conf = 'SANITIZER:COMMAND_INJECTION:node_modules/sanitizer/index.js:sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { sanitize } = requireAndPublish('./resources/node_modules/anotherlib/node_modules/sanitizer')
        const result = sanitize('input')

        assert.equal(result, 'sanitized input')
        sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_COMMAND_INJECTION_MARK, true)
      })

      it('should not fail with not found node_module dep', () => {
        const conf = 'SANITIZER:COMMAND_INJECTION:node_modules/not_loaded_sanitizer/index.js:sanitize'
        securityControls.configure({ securityControlsConfiguration: conf })

        const { sanitize } = requireAndPublish('./resources/node_modules/sanitizer')
        const result = sanitize('input')

        assert.equal(result, 'sanitized input')
        sinon.assert.notCalled(addSecureMark)
      })
    })
  })
})
