'use strict'

const { assert } = require('chai')
const { parse } = require('../../../../src/appsec/iast/security-controls/parser')

const {
  COMMAND_INJECTION_MARK,
  CODE_INJECTION_MARK,
  CUSTOM_SECURE_MARK
} = require('../../../../src/appsec/iast/taint-tracking/secure-marks')

describe('IAST Security Controls parser', () => {
  describe('parse', () => {
    it('should not parse invalid type', () => {
      const conf = 'INVALID_TYPE:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      assert.isUndefined(civ)
    })

    it('should not parse invalid security control definition with extra fields', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1:extra_invalid'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      assert.isUndefined(civ)
    })

    it('should not parse invalid security mark security control definition', () => {
      const conf = 'INPUT_VALIDATOR:INVALID_MARK:bar/foo/custom_input_validator.js:validate:1'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      assert.isUndefined(civ)
    })

    it('should parse valid simple security control definition without parameters', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      expect(civ).not.undefined
      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: undefined
      })
    })

    it('should parse valid simple security control definition for a sanitizer', () => {
      const conf = 'SANITIZER:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'SANITIZER',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: undefined
      })
    })

    it('should parse security control definition containing spaces or alike', () => {
      const conf = `INPUT_VALIDATOR  : COMMAND_INJECTION:  
        bar/foo/custom_input_validator.js:   validate`
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: undefined
      })
    })

    it('should parse valid simple security control definition with multiple marks', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION, CODE_INJECTION:bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK | CODE_INJECTION_MARK,
        method: 'validate',
        parameters: undefined
      })
    })

    it('should parse valid simple security control definition with multiple marks ignoring empty values', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION, CODE_INJECTION, , :bar/foo/custom_input_validator.js:validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK | CODE_INJECTION_MARK,
        method: 'validate',
        parameters: undefined
      })
    })

    it('should parse valid simple security control definition within exported object', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validator.validate'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validator.validate',
        parameters: undefined
      })
    })

    it('should parse valid simple security control definition within exported object and parameter', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validator.validate:1'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validator.validate',
        parameters: [1]
      })
    })

    it('should parse valid simple security control definition with one parameter', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: [1]
      })
    })

    it('should parse valid simple security control definition with multiple parameters', () => {
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')[0]

      assert.deepStrictEqual(civ, {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
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

      assert.deepStrictEqual(civ[0], {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: [1, 2]
      })

      assert.deepStrictEqual(civ[1], {
        type: 'SANITIZER',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'sanitize',
        parameters: undefined
      })
    })

    it('should parse valid multiple security control definitions for different files', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2;\
SANITIZER:COMMAND_INJECTION:bar/foo/sanitizer.js:sanitize'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      assert.deepStrictEqual(civ[0], {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: [1, 2]
      })

      const sanitizerJs = securityControls.get('bar/foo/sanitizer.js')
      assert.deepStrictEqual(sanitizerJs[0], {
        type: 'SANITIZER',
        file: 'bar/foo/sanitizer.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'sanitize',
        parameters: undefined
      })
    })

    it('should parse valid multiple security control definitions for different files ignoring empty', () => {
      // eslint-disable-next-line no-multi-str
      const conf = 'INPUT_VALIDATOR:COMMAND_INJECTION:bar/foo/custom_input_validator.js:validate:1,2;;'
      const securityControls = parse(conf)

      const civ = securityControls.get('bar/foo/custom_input_validator.js')

      assert.deepStrictEqual(civ[0], {
        type: 'INPUT_VALIDATOR',
        file: 'bar/foo/custom_input_validator.js',
        secureMarks: CUSTOM_SECURE_MARK | COMMAND_INJECTION_MARK,
        method: 'validate',
        parameters: [1, 2]
      })
    })
  })
})
