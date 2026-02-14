'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { assertObjectContains } = require('../helpers')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('captureExpressions', function () {
    const t = setup({ testApp: 'target-app/snapshot.js', dependencies: ['fastify'] })

    beforeEach(() => { t.triggerBreakpoint() })

    async function captureExpressionsSnapshot (captureExpressions, additionalConfig = {}) {
      t.agent.addRemoteConfig(t.generateRemoteConfig({
        captureExpressions,
        ...additionalConfig,
      }))

      const [{ payload: [{ debugger: { snapshot } }] }] = await once(t.agent, 'debugger-input')

      return snapshot
    }

    it('should capture a simple variable expression', async function () {
      const snapshot = await captureExpressionsSnapshot([
        { name: 'num', expr: { dsl: 'num', json: { ref: 'num' } } },
      ])

      assert.deepStrictEqual(snapshot.captures, {
        lines: {
          [t.breakpoint.line]: {
            captureExpressions: {
              num: { type: 'number', value: '42' },
            },
          },
        },
      })
    })

    it('should capture multiple expressions', async function () {
      const snapshot = await captureExpressionsSnapshot([
        { name: 'num', expr: { dsl: 'num', json: { ref: 'num' } } },
        { name: 'str', expr: { dsl: 'str', json: { ref: 'str' } } },
        { name: 'bool', expr: { dsl: 'bool', json: { ref: 'bool' } } },
      ])

      assert.deepStrictEqual(snapshot.captures, {
        lines: {
          [t.breakpoint.line]: {
            captureExpressions: {
              num: { type: 'number', value: '42' },
              str: { type: 'string', value: 'foo' },
              bool: { type: 'boolean', value: 'true' },
            },
          },
        },
      })
    })

    it('should capture nested expressions', async function () {
      const snapshot = await captureExpressionsSnapshot([{
        name: 'obj.foo.baz',
        expr: { dsl: 'obj.foo.baz', json: { getmember: [{ getmember: [{ ref: 'obj' }, 'foo'] }, 'baz'] } },
      }])

      assert.deepStrictEqual(snapshot.captures, {
        lines: {
          [t.breakpoint.line]: {
            captureExpressions: { 'obj.foo.baz': { type: 'number', value: '42' } },
          },
        },
      })
    })

    describe('error handling', function () {
      it('should report evaluation errors for invalid expressions', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'num', expr: { dsl: 'num', json: { ref: 'num' } } },
          { name: 'invalid', expr: { dsl: 'invalid', json: { ref: 'invalid' } } },
        ])

        assert.strictEqual(snapshot.evaluationErrors.length, 1)
        assert.deepStrictEqual(Object.keys(snapshot.evaluationErrors[0]), ['expr', 'message'])
        assert.strictEqual(snapshot.evaluationErrors[0].expr, 'invalid')
        assert.ok(snapshot.evaluationErrors[0].message.startsWith('ReferenceError: invalid is not defined'))

        // Valid expression should still be captured
        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                num: { type: 'number', value: '42' },
              },
            },
          },
        })
      })

      it('should report error when both captureSnapshot and captureExpressions are set', async function () {
        t.agent.addRemoteConfig(t.generateRemoteConfig({
          captureSnapshot: true,
          captureExpressions: [
            { name: 'num', expr: { dsl: 'num', json: { ref: 'num' } } },
          ],
        }))

        const [{ payload }] = await once(t.agent, 'debugger-diagnostics')

        const errorDiagnostic = payload.find(({ debugger: { diagnostics } }) => diagnostics.status === 'ERROR')
        assert.ok(errorDiagnostic, 'Should receive ERROR diagnostic')
        const errorMessage = errorDiagnostic.debugger.diagnostics.exception.message
        assert.ok(
          errorMessage.includes('Cannot set both captureSnapshot and captureExpressions'),
          `Expected error message about mutual exclusivity, got: ${errorMessage}`
        )

        const installedDiagnostic = payload.find(({ debugger: { diagnostics } }) => diagnostics.status === 'INSTALLED')
        assert.ok(
          !installedDiagnostic,
          'Probe should not be installed when both captureSnapshot and captureExpressions are set'
        )
      })

      it('should report error when capture expression cannot be compiled', function (done) {
        const rcConfig = t.generateRemoteConfig({
          captureExpressions: [
            { name: 'invalid expr', expr: { dsl: 'this is not valid', json: { ref: 'this is not valid' } } },
          ],
        })

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          const errorDiagnostic = payload.find(({ debugger: { diagnostics } }) => diagnostics.status === 'ERROR')
          if (errorDiagnostic) {
            assert.ok(
              errorDiagnostic.debugger.diagnostics.exception.message.includes('Cannot compile capture expression'),
              `Expected compile error, got: ${errorDiagnostic.debugger.diagnostics.exception.message}`
            )

            const installedDiagnostic = payload.find(({ debugger: { diagnostics } }) => {
              return diagnostics.status === 'INSTALLED'
            })
            assert.ok(!installedDiagnostic, 'Probe should not be installed when expression cannot be compiled')
            done()
          }
        })

        t.agent.addRemoteConfig(rcConfig)
      })
    })

    describe('capture limits', function () {
      it('should respect per-expression maxReferenceDepth', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'obj', expr: { dsl: 'obj', json: { ref: 'obj' } }, capture: { maxReferenceDepth: 0 } },
        ])

        // With maxReferenceDepth: 0, the object itself should show notCapturedReason: 'depth'
        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                obj: {
                  type: 'Object',
                  notCapturedReason: 'depth',
                },
              },
            },
          },
        })
      })

      it('should not include parent properties in the count towards maxReferenceDepth', async function () {
        const snapshot = await captureExpressionsSnapshot(
          [{
            name: 'obj.foo.deep',
            expr: {
              dsl: 'obj.foo.deep',
              json: { getmember: [{ getmember: [{ ref: 'obj' }, 'foo'] }, 'deep'] },
            },
          }],
          { capture: { maxReferenceDepth: 2 } }
        )

        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                'obj.foo.deep': {
                  type: 'Object',
                  fields: {
                    nested: {
                      type: 'Object',
                      fields: {
                        obj: { type: 'Object', notCapturedReason: 'depth' },
                      },
                    },
                  },
                },
              },
            },
          },
        })
      })

      it('should respect per-expression maxCollectionSize', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'arr', expr: { dsl: 'arr', json: { ref: 'arr' } }, capture: { maxCollectionSize: 5 } },
        ])

        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                arr: {
                  type: 'Array',
                  elements: [
                    { type: 'number', value: '1' },
                    { type: 'number', value: '2' },
                    { type: 'number', value: '3' },
                    { type: 'number', value: '4' },
                    { type: 'number', value: '5' },
                  ],
                  notCapturedReason: 'collectionSize',
                  size: 200,
                },
              },
            },
          },
        })
      })

      it('should respect per-expression maxFieldCount', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'obj', expr: { dsl: 'obj', json: { ref: 'obj' } }, capture: { maxFieldCount: 1 } },
        ])

        const { captureExpressions } = snapshot.captures.lines[t.breakpoint.line]
        assert.deepStrictEqual(Object.keys(captureExpressions.obj), ['type', 'fields', 'notCapturedReason', 'size'])
        assertObjectContains(captureExpressions.obj, {
          type: 'Object',
          fields: {
            foo: {
              type: 'Object',
              fields: {
                // And so on...
              },
              notCapturedReason: 'fieldCount',
              size: 4,
            },
          },
          notCapturedReason: 'fieldCount',
          size: 2,
        })
        assert.strictEqual(Object.keys(captureExpressions.obj.fields).length, 1)
      })

      it('should respect per-expression maxLength', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'lstr', expr: { dsl: 'lstr', json: { ref: 'lstr' } }, capture: { maxLength: 10 } },
        ])

        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                lstr: { type: 'string', value: 'Lorem ipsu', truncated: true, size: 445 },
              },
            },
          },
        })
      })

      it('should use probe maxReferenceDepth when per-expression limit is not specified', async function () {
        const snapshot = await captureExpressionsSnapshot(
          // Include a capture object without maxReferenceDepth to test that it still uses the probe limit
          [{ name: 'obj', expr: { dsl: 'obj', json: { ref: 'obj' } }, capture: { maxLength: 3 } }],
          { capture: { maxReferenceDepth: 3 } }
        )

        assertObjectContains(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                obj: {
                  type: 'Object',
                  fields: {
                    foo: {
                      type: 'Object',
                      fields: {
                        deep: {
                          type: 'Object',
                          fields: { nested: { type: 'Object', notCapturedReason: 'depth' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        })
      })

      it('should use probe maxCollectionSize when per-expression limit is not specified', async function () {
        const snapshot = await captureExpressionsSnapshot(
          [{ name: 'arr', expr: { dsl: 'arr', json: { ref: 'arr' } }, capture: { maxReferenceDepth: 3 } }],
          { capture: { maxCollectionSize: 10 } }
        )

        const { captureExpressions } = snapshot.captures.lines[t.breakpoint.line]
        assert.strictEqual(captureExpressions.arr.type, 'Array')
        assert.strictEqual(captureExpressions.arr.elements.length, 10)
        assert.strictEqual(captureExpressions.arr.notCapturedReason, 'collectionSize')
        assert.strictEqual(captureExpressions.arr.size, 200)
      })

      it('should use probe maxFieldCount when per-expression limit is not specified', async function () {
        const snapshot = await captureExpressionsSnapshot(
          [{ name: 'obj', expr: { dsl: 'obj', json: { ref: 'obj' } } }],
          { capture: { maxFieldCount: 1 } }
        )

        const { captureExpressions } = snapshot.captures.lines[t.breakpoint.line]
        assert.strictEqual(captureExpressions.obj.type, 'Object')
        assert.strictEqual(Object.keys(captureExpressions.obj.fields).length, 1)
        assert.strictEqual(captureExpressions.obj.notCapturedReason, 'fieldCount')
        assert.strictEqual(captureExpressions.obj.size, 2)
      })

      it('should use probe maxLength when per-expression limit is not specified', async function () {
        const snapshot = await captureExpressionsSnapshot(
          [{ name: 'lstr', expr: { dsl: 'lstr', json: { ref: 'lstr' } } }],
          { capture: { maxLength: 20 } }
        )

        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                lstr: { type: 'string', value: 'Lorem ipsum dolor si', truncated: true, size: 445 },
              },
            },
          },
        })
      })
    })

    // The full test coverage is covered by the regular snapshot tests
    describe('data types smoke test', function () {
      it('should capture nested object property using getmember', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'obj.foo', expr: { dsl: 'obj.foo', json: { getmember: [{ ref: 'obj' }, 'foo'] } } },
        ])

        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                'obj.foo': {
                  type: 'Object',
                  fields: {
                    baz: { type: 'number', value: '42' },
                    deep: {
                      type: 'Object',
                      fields: {
                        nested: {
                          type: 'Object',
                          fields: {
                            obj: {
                              type: 'Object',
                              notCapturedReason: 'depth',
                            },
                          },
                        },
                      },
                    },
                    nil: { type: 'null', isNull: true },
                    undef: { type: 'undefined' },
                  },
                },
              },
            },
          },
        })
      })

      it('should capture array expression', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'arr', expr: { dsl: 'arr', json: { ref: 'arr' } } },
        ])

        const { captureExpressions } = snapshot.captures.lines[t.breakpoint.line]
        assert.ok(captureExpressions.arr, 'arr should be captured')
        assert.strictEqual(captureExpressions.arr.type, 'Array')
        // Array captures include elements as an object with numeric keys, check at least first element
        const hasElements = captureExpressions.arr.elements || captureExpressions.arr.fields
        assert.ok(hasElements, 'elements or fields should be present')
        if (captureExpressions.arr.elements) {
          assert.deepStrictEqual(captureExpressions.arr.elements[0], { type: 'number', value: '1' })
        }
      })

      it('should capture Map expressions', async function () {
        const snapshot = await captureExpressionsSnapshot([
          { name: 'map', expr: { dsl: 'map', json: { ref: 'map' } } },
        ])

        assert.deepStrictEqual(snapshot.captures, {
          lines: {
            [t.breakpoint.line]: {
              captureExpressions: {
                map: {
                  type: 'Map',
                  entries: [],
                },
              },
            },
          },
        })
      })
    })
  })
})
