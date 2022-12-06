'use strict'
const dc = require('diagnostics_channel')
const { assert } = require('chai')
const Hook = require('../src/ritm')

const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

describe('Ritm', () => {
  it('should shim util', () => {
    const startListener = sinon.fake()
    const endListener = sinon.fake()

    moduleLoadStartChannel.subscribe(startListener)
    moduleLoadEndChannel.subscribe(endListener)
    Hook('util')
    require('util')

    assert.equal(startListener.callCount, 1)
    assert.equal(endListener.callCount, 1)
  })

  it('should handle module load cycles', () => {
    const startListener = sinon.fake()
    const endListener = sinon.fake()

    moduleLoadStartChannel.subscribe(startListener)
    moduleLoadEndChannel.subscribe(endListener)
    Hook('module-a')
    Hook('module-b')
    const { a } = require('./ritm-tests/module-a')

    assert.equal(startListener.callCount, 2)
    assert.equal(endListener.callCount, 2)
    assert.equal(a(), 'Called by AJ')
  })
})
