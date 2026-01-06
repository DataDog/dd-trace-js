'use strict'

const assert = require('node:assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('../setup/core')

const Plugin = require('../../src/plugins/plugin')
const CompositePlugin = require('../../src/plugins/composite')

describe('CompositePlugin', () => {
  let configureSpy1
  let configureSpy2
  let configureSpy3

  class PluginA extends Plugin {
    static id = 'pluginA'
  }

  class PluginB extends Plugin {
    static id = 'pluginB'
  }

  class PluginC extends Plugin {
    static id = 'pluginC'
  }

  beforeEach(() => {
    configureSpy1 = sinon.spy(PluginA.prototype, 'configure')
    configureSpy2 = sinon.spy(PluginB.prototype, 'configure')
    configureSpy3 = sinon.spy(PluginC.prototype, 'configure')
  })

  afterEach(() => {
    configureSpy1.restore()
    configureSpy2.restore()
    configureSpy3.restore()
  })

  it('should load plugins when provided as an array', () => {
    class TestComposite extends CompositePlugin {
      static id = 'test'
      static plugins = {
        plugins: [PluginA, PluginB]
      }
    }

    const composite = new TestComposite()

    assert.ok(composite.pluginA instanceof PluginA)
    assert.ok(composite.pluginB instanceof PluginB)
  })

  it('should load plugins when provided as single classes', () => {
    class TestComposite extends CompositePlugin {
      static id = 'test'
      static plugins = {
        pluginA: PluginA,
        pluginB: PluginB
      }
    }

    const composite = new TestComposite()

    assert.ok(composite.pluginA instanceof PluginA)
    assert.ok(composite.pluginB instanceof PluginB)
  })

  it('should load mixed single and array plugins', () => {
    class TestComposite extends CompositePlugin {
      static id = 'test'
      static plugins = {
        pluginA: PluginA,
        others: [PluginB, PluginC]
      }
    }

    const composite = new TestComposite()

    assert.ok(composite.pluginA instanceof PluginA)
    assert.ok(composite.pluginB instanceof PluginB)
    assert.ok(composite.pluginC instanceof PluginC)
  })

  it('should configure all plugins from array', () => {
    class TestComposite extends CompositePlugin {
      static id = 'test'
      static plugins = {
        plugins: [PluginA, PluginB]
      }
    }

    const composite = new TestComposite()
    composite.configure({ enabled: true })

    assert.ok(configureSpy1.calledOnce)
    assert.ok(configureSpy2.calledOnce)
  })
})