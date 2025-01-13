'use strict'

const proxyquire = require('proxyquire')
const { CUSTOM_SECURE_MARK, COMMAND_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')
const { saveIastContext } = require('../../../../src/appsec/iast/iast-context')

describe('IAST Security Controls', () => {
  let securityControls, addSecureMark, iastContext

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

  it('should hook configured control for input_validator', () => {
    // eslint-disable-next-line no-multi-str
    const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:packages/dd-trace/test/appsec/iast\
/security-controls/resources/custom_input_validator.js:validate'
    securityControls.configure({ securityControlsConfiguration: conf })

    const { validate } = require('./resources/custom_input_validator')
    validate('input')

    sinon.assert.calledOnceWithExactly(addSecureMark, iastContext, 'input', CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK)
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
})
