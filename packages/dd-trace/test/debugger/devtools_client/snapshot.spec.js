'use strict'

require('../../setup/tap')

const { expect } = require('chai')

const inspector = require('../../../src/debugger/devtools_client/inspector_promises_polyfill')
const session = new inspector.Session()
session.connect()

const { getPrimitives, getComplextTypes, getNestedObj } = require('./_inspected_file')

const mockedState = {
  breakpoints: new Map(),
  '@noCallThru': true
}
session['@noCallThru'] = true
const { getLocalStateForBreakpoint } = proxyquire('../src/debugger/devtools_client/snapshot', {
  './state': mockedState,
  './session': session
})

let scriptId

// Be aware, if any of these tests fail, a nasty native stack trace will be thrown along with the test error!
// Just ignore it, as it's a bug in tap: https://github.com/tapjs/libtap/issues/53
describe('debugger -> devtools client -> snapshot.getLocalStateForBreakpoint', () => {
  beforeEach(async () => {
    scriptId = new Promise((resolve) => {
      session.on('Debugger.scriptParsed', ({ params }) => {
        if (params.url.endsWith('/_inspected_file.js')) {
          session.removeAllListeners('Debugger.scriptParsed') // TODO: Can we do this in prod code?
          resolve(params.scriptId)
        }
      })
    })

    await session.post('Debugger.enable')
  })

  afterEach(async () => {
    await session.post('Debugger.disable')
  })

  it('should return expected object for primitives', async () => {
    session.once('Debugger.paused', async ({ params }) => {
      expect(params.hitBreakpoints.length).to.eq(1)

      const state = await getLocalStateForBreakpoint(params)

      expect(Object.entries(state).length).to.equal(7)
      expect(state).to.have.deep.property('myUndef', { type: 'undefined', value: undefined })
      expect(state).to.have.deep.property('myNull', { type: 'null', isNull: true })
      expect(state).to.have.deep.property('myBool', { type: 'boolean', value: true })
      expect(state).to.have.deep.property('myNumber', { type: 'number', value: 42 })
      expect(state).to.have.deep.property('myBigInt', { type: 'bigint', value: '42n' })
      expect(state).to.have.deep.property('myString', { type: 'string', value: 'foo' })
      expect(state).to.have.deep.property('mySym', { type: 'symbol', value: 'Symbol(foo)' })
    })

    await setBreakpointOnLine(6)
    getPrimitives()
  })

  it('should return expected object for complex types', async () => {
    session.once('Debugger.paused', async ({ params }) => {
      expect(params.hitBreakpoints.length).to.eq(1)

      const state = await getLocalStateForBreakpoint(params)

      expect(Object.entries(state).length).to.equal(10)
      expect(state).to.have.deep.property('myRegex', { type: 'regexp', value: '/foo/' })
      expect(state).to.have.deep.property('myMap', { type: 'map', value: 'Map(2)' })
      expect(state).to.have.deep.property('mySet', { type: 'set', value: 'Set(3)' })
      expect(state).to.have.deep.property('myArr', {
        type: 'array',
        elements: [
          { type: 'number', value: 1 },
          { type: 'number', value: 2 },
          { type: 'number', value: 3 }
        ]
      })
      expect(state).to.have.deep.property('myObj', {
        type: 'object',
        fields: {
          a: { type: 'number', value: 1 },
          b: { type: 'number', value: 2 },
          c: { type: 'number', value: 3 }
        }
      })
      expect(state).to.have.deep.property('myFunc', { type: 'function' })
      expect(state).to.have.deep.property('myArrowFunc', { type: 'function' })
      expect(state).to.have.deep.property('myInstance', {
        type: 'object',
        fields: { foo: { type: 'number', value: 42 } }
      })
      expect(state).to.have.deep.property('MyClass', { type: 'class' })
      expect(state).to.have.property('circular')
      expect(state.circular).to.have.property('type', 'object')
      expect(state.circular).to.have.property('fields')
      // For the circular field, just check that at least one of the expected properties are present
      expect(state.circular.fields).to.deep.include({
        myRegex: { type: 'regexp', value: '/foo/' }
      })
    })

    await setBreakpointOnLine(12)
    getComplextTypes()
  })

  it('should return expected object for nested objects with maxReferenceDepth: 1', async () => {
    session.once('Debugger.paused', async ({ params }) => {
      expect(params.hitBreakpoints.length).to.eq(1)

      const state = await getLocalStateForBreakpoint(params)

      expect(Object.entries(state).length).to.equal(1)

      expect(state).to.have.property('myNestedObj')
      expect(state.myNestedObj).to.have.property('type', 'object')
      expect(state.myNestedObj).to.have.property('fields')
      expect(Object.entries(state.myNestedObj).length).to.equal(2)

      expect(state.myNestedObj.fields).to.have.deep.property('deepObj', {
        type: 'object', notCapturedReason: 'depth'
      })

      expect(state.myNestedObj.fields).to.have.deep.property('deepArr', {
        type: 'array', notCapturedReason: 'depth'
      })
    })

    await setBreakpointOnLine(18, 1)
    getNestedObj()
  })

  it('should return expected object for nested objects with maxReferenceDepth: 5', async () => {
    session.once('Debugger.paused', async ({ params }) => {
      expect(params.hitBreakpoints.length).to.eq(1)

      const state = await getLocalStateForBreakpoint(params)

      expect(Object.entries(state).length).to.equal(1)

      expect(state).to.have.property('myNestedObj')
      expect(state.myNestedObj).to.have.property('type', 'object')
      expect(state.myNestedObj).to.have.property('fields')
      expect(Object.entries(state.myNestedObj).length).to.equal(2)

      expect(state.myNestedObj.fields).to.have.deep.property('deepObj', {
        type: 'object',
        fields: {
          foo: {
            type: 'object',
            fields: {
              foo: {
                type: 'object',
                fields: {
                  foo: {
                    type: 'object',
                    fields: {
                      foo: { type: 'object', notCapturedReason: 'depth' }
                    }
                  }
                }
              }
            }
          }
        }
      })

      expect(state.myNestedObj.fields).to.have.deep.property('deepArr', {
        type: 'array',
        elements: [
          {
            type: 'array',
            elements: [
              {
                type: 'array',
                elements: [
                  {
                    type: 'array',
                    elements: [{ type: 'array', notCapturedReason: 'depth' }]
                  }
                ]
              }
            ]
          }
        ]
      })
    })

    await setBreakpointOnLine(18, 5)
    getNestedObj()
  })
})

async function setBreakpointOnLine (line, maxReferenceDepth = 2) {
  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId: await scriptId,
      lineNumber: line - 1 // Beware! lineNumber is zero-indexed
    }
  })
  mockedState.breakpoints.set(breakpointId, {
    capture: {
      maxReferenceDepth
    }
  })
}
