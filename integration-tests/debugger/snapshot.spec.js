'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ dependencies: ['fastify'] })

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(t.triggerBreakpoint)

      it('should capture a snapshot', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
          assert.deepEqual(Object.keys(captures), ['lines'])
          assert.deepEqual(Object.keys(captures.lines), [String(t.breakpoint.line)])

          const { locals } = captures.lines[t.breakpoint.line]
          const { request, fastify, getUndefined } = locals
          delete locals.request
          delete locals.fastify
          delete locals.getUndefined

          // from block scope
          assert.deepEqual(locals, {
            nil: { type: 'null', isNull: true },
            undef: { type: 'undefined' },
            bool: { type: 'boolean', value: 'true' },
            num: { type: 'number', value: '42' },
            bigint: { type: 'bigint', value: '42' },
            str: { type: 'string', value: 'foo' },
            lstr: {
              type: 'string',
              // eslint-disable-next-line @stylistic/max-len
              value: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor i',
              truncated: true,
              size: 445
            },
            sym: { type: 'symbol', value: 'Symbol(foo)' },
            regex: { type: 'RegExp', value: '/bar/i' },
            arr: {
              type: 'Array',
              elements: [
                { type: 'number', value: '1' },
                { type: 'number', value: '2' },
                { type: 'number', value: '3' },
                { type: 'number', value: '4' },
                { type: 'number', value: '5' }
              ]
            },
            obj: {
              type: 'Object',
              fields: {
                foo: {
                  type: 'Object',
                  fields: {
                    baz: { type: 'number', value: '42' },
                    nil: { type: 'null', isNull: true },
                    undef: { type: 'undefined' },
                    deep: {
                      type: 'Object',
                      fields: { nested: { type: 'Object', notCapturedReason: 'depth' } }
                    }
                  }
                },
                bar: { type: 'boolean', value: 'true' }
              }
            },
            emptyObj: { type: 'Object', fields: {} },
            p: {
              type: 'Promise',
              fields: {
                '[[PromiseState]]': { type: 'string', value: 'fulfilled' },
                '[[PromiseResult]]': { type: 'undefined' }
              }
            },
            arrowFn: {
              type: 'Function',
              fields: {
                length: { type: 'number', value: '0' },
                name: { type: 'string', value: 'arrowFn' }
              }
            }
          })

          // from local scope
          // There's no reason to test the `request` object 100%, instead just check its fingerprint
          assert.deepEqual(Object.keys(request), ['type', 'fields'])
          assert.equal(request.type, 'Request')
          assert.equal(request.fields.id.type, 'string')
          assert.match(request.fields.id.value, /^req-\d+$/)
          assert.deepEqual(request.fields.params, {
            type: 'NullObject', fields: { name: { type: 'string', value: 'foo' } }
          })
          assert.deepEqual(request.fields.query, { type: 'Object', fields: {} })
          assert.deepEqual(request.fields.body, { type: 'undefined' })

          // from closure scope
          // There's no reason to test the `fastify` object 100%, instead just check its fingerprint
          assert.equal(fastify.type, 'Object')
          assert.typeOf(fastify.fields, 'Object')

          assert.deepEqual(getUndefined, {
            type: 'Function',
            fields: {
              length: { type: 'number', value: '0' },
              name: { type: 'string', value: 'getUndefined' }
            }
          })

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))
      })

      it('should respect maxReferenceDepth', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
          const { locals } = captures.lines[t.breakpoint.line]
          delete locals.request
          delete locals.fastify
          delete locals.getUndefined

          assert.deepEqual(locals, {
            nil: { type: 'null', isNull: true },
            undef: { type: 'undefined' },
            bool: { type: 'boolean', value: 'true' },
            num: { type: 'number', value: '42' },
            bigint: { type: 'bigint', value: '42' },
            str: { type: 'string', value: 'foo' },
            lstr: {
              type: 'string',
              // eslint-disable-next-line @stylistic/max-len
              value: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor i',
              truncated: true,
              size: 445
            },
            sym: { type: 'symbol', value: 'Symbol(foo)' },
            regex: { type: 'RegExp', value: '/bar/i' },
            arr: { type: 'Array', notCapturedReason: 'depth' },
            obj: { type: 'Object', notCapturedReason: 'depth' },
            emptyObj: { type: 'Object', notCapturedReason: 'depth' },
            p: { type: 'Promise', notCapturedReason: 'depth' },
            arrowFn: { type: 'Function', notCapturedReason: 'depth' }
          })

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true, capture: { maxReferenceDepth: 0 } }))
      })

      it('should respect maxLength', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
          const { locals } = captures.lines[t.breakpoint.line]

          assert.deepEqual(locals.lstr, {
            type: 'string',
            value: 'Lorem ipsu',
            truncated: true,
            size: 445
          })

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true, capture: { maxLength: 10 } }))
      })

      it('should respect maxCollectionSize', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
          const { locals } = captures.lines[t.breakpoint.line]

          assert.deepEqual(locals.arr, {
            type: 'Array',
            elements: [
              { type: 'number', value: '1' },
              { type: 'number', value: '2' },
              { type: 'number', value: '3' }
            ],
            notCapturedReason: 'collectionSize',
            size: 5
          })

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true, capture: { maxCollectionSize: 3 } }))
      })

      it('should respect maxFieldCount', (done) => {
        const maxFieldCount = 3

        function assertMaxFieldCount (prop) {
          if ('fields' in prop) {
            if (prop.notCapturedReason === 'fieldCount') {
              assert.strictEqual(Object.keys(prop.fields).length, maxFieldCount)
              assert.isAbove(prop.size, maxFieldCount)
            } else {
              assert.isBelow(Object.keys(prop.fields).length, maxFieldCount)
            }
          }

          for (const value of Object.values(prop.fields || prop.elements || prop.entries || {})) {
            assertMaxFieldCount(value)
          }
        }

        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
          const { locals } = captures.lines[t.breakpoint.line]

          assert.deepStrictEqual(Object.keys(locals), [
            // Up to 3 properties from the closure scope
            'fastify', 'getUndefined',
            // Up to 3 properties from the local scope
            'request', 'nil', 'undef'
          ])

          assert.strictEqual(locals.request.type, 'Request')
          assert.strictEqual(Object.keys(locals.request.fields).length, maxFieldCount)
          assert.strictEqual(locals.request.notCapturedReason, 'fieldCount')
          assert.isAbove(locals.request.size, maxFieldCount)

          assert.strictEqual(locals.fastify.type, 'Object')
          assert.strictEqual(Object.keys(locals.fastify.fields).length, maxFieldCount)
          assert.strictEqual(locals.fastify.notCapturedReason, 'fieldCount')
          assert.isAbove(locals.fastify.size, maxFieldCount)

          for (const value of Object.values(locals)) {
            assertMaxFieldCount(value)
          }

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true, capture: { maxFieldCount } }))
      })
    })
  })
})
