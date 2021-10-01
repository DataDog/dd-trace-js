'use strict'

describe.skip('getScope', () => {
  let getScope
  let versionDescriptor
  const ASYNC_RESOURCE = { name: 'async_resource' }
  const ASYNC_HOOKS = { name: 'async_hooks' }

  beforeEach(() => {
    versionDescriptor = Reflect.getOwnPropertyDescriptor(process.versions, 'node')
  })

  afterEach(() => {
    Reflect.defineProperty(process.versions, 'node', versionDescriptor)
  })

  it('should default to AsyncLocalStorage on supported versions, and async_hooks on unsupported versions', () => {
    function assertVersion (version, als) {
      Reflect.defineProperty(process.versions, 'node', {
        value: version,
        configurable: true
      })
      getScope = proxyquire('../src/scope', {
        './scope/async_resource': ASYNC_RESOURCE,
        './scope/async_hooks': ASYNC_HOOKS
      })
      expect(getScope()).to.equal(als ? ASYNC_RESOURCE : ASYNC_HOOKS)
    }
    assertVersion('10.0.0', false)
    assertVersion('12.0.0', false)
    assertVersion('12.18.99', false)
    assertVersion('12.19.0', true)
    assertVersion('13.0.0', false)
    assertVersion('14.0.0', false)
    assertVersion('14.4.99', false)
    assertVersion('14.5.0', true)
    assertVersion('14.5.1', true)
    assertVersion('14.6.0', true)
    assertVersion('15.0.0', true)
    assertVersion('16.0.0', true)
    assertVersion('17.0.0', true)
  })

  it('should go with user choice when scope is defined in options', () => {
    expect(getScope('async_resource')).to.equal(ASYNC_RESOURCE)
    expect(getScope('async_hooks')).to.equal(ASYNC_HOOKS)
  })
})
