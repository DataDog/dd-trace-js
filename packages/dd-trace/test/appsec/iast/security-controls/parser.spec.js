'use strict'

const { expect } = require('chai')
const { parse } = require('../../../../src/appsec/iast/security-controls/parser')

const {
  COMMAND_INJECTION_MARK,
  CODE_INJECTION_MARK
} = require('../../../../src/appsec/iast/taint-tracking/secure-marks')

describe('IAST Security Controls parser', () => {
  describe('parse', () => {
    it('should not parse invalid type', () => {
      const conf = 'INVALID_TYPE:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      expect(civ).to.undefined
    })

    it('should not parse invalid security control definition with extra fields', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1:extra_invalid'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      expect(civ).to.undefined
    })

    it('should not parse invalid security mark security control definition', () => {
      const conf = 'INPUT_VALIDATOR:INVALID_MARK:bar/foo/custom_input_validator.js:validate:1'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      expect(civ).to.undefined
    })

    it('should parse valid simple security control definition without parameters', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate'
      })
    })

    it('should parse valid simple security control definition for a sanitizer', () => {
      const conf = 'SANITIZER:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'SANITIZER',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate'
      })
    })

    it('should parse security control definition containing spaces or alike', () => {
      const conf = `INPUT_VALIDATOR  : COMMAND_INJECTION:  
        bar/foo/custom_input_validator.js:   validate`
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate'
      })
    })

    it('should parse valid simple security control definition with multiple marks', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION, CODE_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK, CODE_INJECTION_MARK],
        method: 'validate'
      })
    })

    it('should parse valid simple security control definition with multiple marks ignoring empty values', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION, CODE_INJECTION, , :bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK, CODE_INJECTION_MARK],
        method: 'validate'
      })
    })

    it('should parse valid simple security control definition with one parameter', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate',
        parameters: [1]
      })
    })

    it('should parse valid simple security control definition with multiple parameters', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      expect(civ).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate',
        parameters: [1, 2]
      })
    })

    it('should parse valid multiple security control definitions for the same file', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2;\
SANITIZER:COMMAND_INJECTION:bar/foo/custom_input_validator.js:sanitize'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      expect(civ[0]).not.undefined
      expect(civ[0]).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate',
        parameters: [1, 2]
      })

      expect(civ[1]).not.undefined
      expect(civ[1]).to.deep.include({
        type: 'SANITIZER',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'sanitize'
      })
    })

    it('should parse valid multiple security control definitions for the different files', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2;\
SANITIZER:COMMAND_INJECTION:bar/foo/sanitizer.js:sanitize'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      expect(civ[0]).not.undefined
      expect(civ[0]).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate',
        parameters: [1, 2]
      })

      const sanitizerJs = securityControls.get('bar/foo/sanitizer.js')
      expect(sanitizerJs[0]).not.undefined
      expect(sanitizerJs[0]).to.deep.include({
        type: 'SANITIZER',
        file: 'bar/foo/sanitizer.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'sanitize'
      })
    })

    it('should parse valid multiple security control definitions for the different files ignoring empty', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2;;'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      expect(civ[0]).not.undefined
      expect(civ[0]).to.deep.include({
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: [COMMAND_INJECTION_MARK],
        method: 'validate',
        parameters: [1, 2]
      })
    })
  })
})
