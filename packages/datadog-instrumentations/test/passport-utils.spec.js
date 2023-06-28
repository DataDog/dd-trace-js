'use strict'

const proxyquire = require('proxyquire')
const { channel } = require('../src/helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

describe('passport-utils', () => {
  const shimmer = {
    wrap: sinon.stub()
  }

  let passportUtils

  beforeEach(() => {
    passportUtils = proxyquire('../src/passport-utils', {
      '../../datadog-shimmer': shimmer
    })
  })

  it('should not call wrap when there is no subscribers', () => {
    const wrap = passportUtils.wrapVerify(() => {}, false, 'type')

    wrap()
    expect(shimmer.wrap).not.to.have.been.called
  })

  it('should call wrap when there is subscribers', () => {
    const wrap = passportUtils.wrapVerify(() => {}, false, 'type')

    passportVerifyChannel.subscribe(() => {})

    wrap()
    expect(shimmer.wrap).to.have.been.called
  })
})
