'use strict'

require('../setup/tap')

const { expect } = require('chai')
const ContextManager = require('../../src/opentelemetry/context_manager')
const { ROOT_CONTEXT } = require('@opentelemetry/api')
const api = require('@opentelemetry/api')

describe('OTel Context Manager', () => {
  let contextManager
  let db

  beforeEach(() => {
    contextManager = new ContextManager()
    api.context.setGlobalContextManager(contextManager)
    db = {
      getSomeValue: async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { name: 'Dummy Name' }
      }
    }
  })

  it('should create a new context', () => {
    const key1 = api.createContextKey('My first key')
    const key2 = api.createContextKey('My second key')
    expect(key1.description).to.equal('My first key')
    expect(key2.description).to.equal('My second key')
  })

  it('should delete a context', () => {
    const key = api.createContextKey('some key')
    const ctx = api.ROOT_CONTEXT
    const ctx2 = ctx.setValue(key, 'context 2')

    // remove the entry
    const ctx3 = ctx.deleteValue(key)

    expect(ctx3.getValue(key)).to.equal(undefined)
    expect(ctx2.getValue(key)).to.equal('context 2')
    expect(ctx.getValue(key)).to.equal(undefined)
  })

  it('should create a new root context', () => {
    const key = api.createContextKey('some key')
    const ctx = api.ROOT_CONTEXT
    const ctx2 = ctx.setValue(key, 'context 2')
    expect(ctx2.getValue(key)).to.equal('context 2')
    expect(ctx.getValue(key)).to.equal(undefined)
  })

  it('should return root context', () => {
    const ctx = api.context.active()
    expect(ctx).to.be.an.instanceof(ROOT_CONTEXT.constructor)
  })

  it('should set active context', () => {
    const key = api.createContextKey('Key to store a value')
    const ctx = api.context.active()

    api.context.with(ctx.setValue(key, 'context 2'), async () => {
      expect(api.context.active().getValue(key)).to.equal('context 2')
    })
  })

  it('should set active context on an asynchronous callback and return the result synchronously', async () => {
    const name = await api.context.with(api.context.active(), async () => {
      const row = await db.getSomeValue()
      return row.name
    })

    expect(name).to.equal('Dummy Name')
  })

  it('should set active contexts in nested functions', async () => {
    const key = api.createContextKey('Key to store a value')
    const ctx = api.context.active()
    expect(api.context.active().getValue(key)).to.equal(undefined)
    api.context.with(ctx.setValue(key, 'context 2'), () => {
      expect(api.context.active().getValue(key)).to.equal('context 2')
      api.context.with(ctx.setValue(key, 'context 3'), () => {
        expect(api.context.active().getValue(key)).to.equal('context 3')
      })
      expect(api.context.active().getValue(key)).to.equal('context 2')
    })
    expect(api.context.active().getValue(key)).to.equal(undefined)
  })

  it('should not modify contexts, instead it should create new context objects', async () => {
    const key = api.createContextKey('Key to store a value')

    const ctx = api.context.active()

    const ctx2 = ctx.setValue(key, 'context 2')
    expect(ctx.getValue(key)).to.equal(undefined)
    expect(ctx).to.be.an.instanceof(ROOT_CONTEXT.constructor)
    expect(ctx2.getValue(key)).to.equal('context 2')

    const ret = api.context.with(ctx2, () => {
      const ctx3 = api.context.active().setValue(key, 'context 3')

      expect(api.context.active().getValue(key)).to.equal('context 2')
      expect(ctx.getValue(key)).to.equal(undefined)
      expect(ctx2.getValue(key)).to.equal('context 2')
      expect(ctx3.getValue(key)).to.equal('context 3')

      api.context.with(ctx3, () => {
        expect(api.context.active().getValue(key)).to.equal('context 3')
      })
      expect(api.context.active().getValue(key)).to.equal('context 2')

      return 'return value'
    })
    expect(ret).to.equal('return value')
  })
})
