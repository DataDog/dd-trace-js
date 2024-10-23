'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup()

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(t.triggerBreakpoint)

      it('should capture a snapshot', function (done) {
        t.agent.on('debugger-input', ({ payload: { 'debugger.snapshot': { captures } } }) => {
          assert.deepEqual(Object.keys(captures), ['lines'])
          assert.deepEqual(Object.keys(captures.lines), [String(t.breakpoint.line)])

          const { locals } = captures.lines[t.breakpoint.line]
          const { request, fastify, getSomeData } = locals
          delete locals.request
          delete locals.fastify
          delete locals.getSomeData

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
              // eslint-disable-next-line max-len
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
            fn: {
              type: 'Function',
              fields: {
                length: { type: 'number', value: '0' },
                name: { type: 'string', value: 'fn' }
              }
            },
            p: {
              type: 'Promise',
              fields: {
                '[[PromiseState]]': { type: 'string', value: 'fulfilled' },
                '[[PromiseResult]]': { type: 'undefined' }
              }
            }
          })

          // from local scope
          // There's no reason to test the `request` object 100%, instead just check its fingerprint
          assert.deepEqual(Object.keys(request), ['type', 'fields'])
          assert.equal(request.type, 'Request')
          assert.deepEqual(request.fields.id, { type: 'string', value: 'req-1' })
          assert.deepEqual(request.fields.params, {
            type: 'NullObject', fields: { name: { type: 'string', value: 'foo' } }
          })
          assert.deepEqual(request.fields.query, { type: 'Object', fields: {} })
          assert.deepEqual(request.fields.body, { type: 'undefined' })

          // from closure scope
          // There's no reason to test the `fastify` object 100%, instead just check its fingerprint
          assert.deepEqual(Object.keys(fastify), ['type', 'fields'])
          assert.equal(fastify.type, 'Object')

          assert.deepEqual(getSomeData, {
            type: 'Function',
            fields: {
              length: { type: 'number', value: '0' },
              name: { type: 'string', value: 'getSomeData' }
            }
          })

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))
      })

      it('should respect maxReferenceDepth', function (done) {
        t.agent.on('debugger-input', ({ payload: { 'debugger.snapshot': { captures } } }) => {
          const { locals } = captures.lines[t.breakpoint.line]
          delete locals.request
          delete locals.fastify
          delete locals.getSomeData

          assert.deepEqual(locals, {
            nil: { type: 'null', isNull: true },
            undef: { type: 'undefined' },
            bool: { type: 'boolean', value: 'true' },
            num: { type: 'number', value: '42' },
            bigint: { type: 'bigint', value: '42' },
            str: { type: 'string', value: 'foo' },
            lstr: {
              type: 'string',
              // eslint-disable-next-line max-len
              value: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor i',
              truncated: true,
              size: 445
            },
            sym: { type: 'symbol', value: 'Symbol(foo)' },
            regex: { type: 'RegExp', value: '/bar/i' },
            arr: { type: 'Array', notCapturedReason: 'depth' },
            obj: { type: 'Object', notCapturedReason: 'depth' },
            emptyObj: { type: 'Object', notCapturedReason: 'depth' },
            fn: { type: 'Function', notCapturedReason: 'depth' },
            p: { type: 'Promise', notCapturedReason: 'depth' }
          })

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true, capture: { maxReferenceDepth: 0 } }))
      })

      it('should respect maxLength', function (done) {
        t.agent.on('debugger-input', ({ payload: { 'debugger.snapshot': { captures } } }) => {
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
        t.agent.on('debugger-input', ({ payload: { 'debugger.snapshot': { captures } } }) => {
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
    })
  })
})
