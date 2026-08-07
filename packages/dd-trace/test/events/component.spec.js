'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')

require('../setup/core')

const { storage } = require('../../../datadog-core')
const EventComponent = require('../../src/events/component')

const legacyStorage = storage('legacy')

describe('EventComponent', () => {
  const components = []

  afterEach(() => {
    for (const component of components) component.configure(false)
    components.length = 0
    legacyStorage.enterWith(undefined)
  })

  it('owns subscription enable and disable lifecycle without Plugin', () => {
    const component = new EventComponent()
    const channel = dc.channel('test:event-component:subscribe')
    let calls = 0

    component.addSub(channel, () => calls++)
    components.push(component)

    component.configure({ enabled: true })
    channel.publish({})
    component.configure({ enabled: false })
    channel.publish({})

    assert.strictEqual(calls, 1)
  })

  it('binds a returned operation store around source execution', () => {
    const component = new EventComponent()
    const channel = dc.channel('test:event-component:bind')
    const expectedStore = { span: {} }
    let activeStore

    component.addBind(channel, () => expectedStore)
    component.configure({ enabled: true })
    components.push(component)

    channel.runStores({}, () => {
      activeStore = legacyStorage.getStore()
    })

    assert.strictEqual(activeStore, expectedStore)
  })
})
