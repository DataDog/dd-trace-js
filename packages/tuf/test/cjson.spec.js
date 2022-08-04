'use strict'

const { expect } = require('chai')
const { serialize } = require('../src/cjson')

const GO_VECTORS = [
  [
    {
      keyval: {
        private: '',
        public: ''
      },
      keyid_hash_algorithms: null,
      keyid: '',
      keytype: '',
      scheme: ''
    },
    `{"keyid":"","keyid_hash_algorithms":null,"keytype":"","keyval":{"private":"","public":""},"scheme":""}`
  ],
  [
    {
      true: true,
      false: false,
      nil: null,
      int: 3,
      int2: 42,
      string: `"`
    },
    `{"false":false,"int":3,"int2":42,"nil":null,"string":"\\"","true":true}`
  ]
]

describe('TUF', () => {
  describe('canonical JSON', () => {
    it('should run the Go test cases', () => {
      for (const [input, output] of GO_VECTORS) {
        expect(serialize(input)).to.equal(output)
      }
    })
    it('should cover edge cases', () => {
      expect(serialize(new String('hello'))).to.equal('"hello"')
      try {
        serialize(/a/)
      } catch (e) {
        expect(e.message).to.equal(`Can't canonicalize /a/ of type RegExp`)
      }
      try {
        serialize(4.2)
      } catch (e) {
        expect(e.message).to.equal(`Can't canonicalize floating point number '4.2'`)
      }
      try {
        serialize(Symbol('foo'))
      } catch (e) {
        expect(e.message).to.equal(`Can't canonicalize Symbol(foo) of type symbol`)
      }
    })
  })
})
