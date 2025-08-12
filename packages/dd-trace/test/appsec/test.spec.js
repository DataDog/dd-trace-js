const Axios = require('axios')
const { assert } = require('chai')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

describe('test', () => {
    it('should fail', () => {
        throw 'loul'
    })
})