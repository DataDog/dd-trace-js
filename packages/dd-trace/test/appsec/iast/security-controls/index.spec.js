'use strict'

const { assert } = require('chai')
const proxyquire = require('proxyquire')
const { CUSTOM_SECURE_MARK, COMMAND_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')
const { saveIastContext } = require('../../../../src/appsec/iast/iast-context')

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

  it('should hook configured control for input_validator', () => {
    // eslint-disable-next-line no-multi-str
    const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom_input_validator.js:validate'
    securityControls.configure({ securityControlsConfiguration: conf })

    const { validate } = require('./resources/custom_input_validator')
    validate('input')

    sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, 'input', CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
  })

  it('should hook configured control for default sanitizer', () => {
    // eslint-disable-next-line no-multi-str
    const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer_default.js'
    securityControls.configure({ securityControlsConfiguration: conf })

    const sanitize = require('./resources/sanitizer_default')
    const result = sanitize('input')

    assert.equal(result, 'sanitized input')
    sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
  })

  it('should hook configured control for input_validator with multiple inputs', () => {
    // eslint-disable-next-line no-multi-str
    const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom_input_validator.js:validate'
    securityControls.configure({ securityControlsConfiguration: conf })

    const { validate } = require('./resources/custom_input_validator')
    validate('input1', 'input2')

    sinon.assert.calledTwice(addSecureMark)
    sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input1', CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
    sinon.assert.calledWithExactly(addSecureMark, iastContext, 'input2', CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
  })

  it('should hook configured control for sanitizer', () => {
    // eslint-disable-next-line no-multi-str
    const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:sanitize'
    securityControls.configure({ securityControlsConfiguration: conf })

    const { sanitize } = require('./resources/sanitizer')
    const result = sanitize('input')

    sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
  })

  it('should hook configured control for sanitizer in nested object', () => {
    // eslint-disable-next-line no-multi-str
    const conf = 'SANITIZER:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/sanitizer.js:nested.sanitize'
    securityControls.configure({ securityControlsConfiguration: conf })

    const { nested } = require('./resources/sanitizer')
    const result = nested.sanitize('input')

    assert.equal(result, 'sanitized input')
    sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, result, CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
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
