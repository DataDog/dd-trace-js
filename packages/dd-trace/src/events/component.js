'use strict'

const dc = require('dc-polyfill')

const logger = require('../log')
const { storage } = require('../../../datadog-core')

const legacyStorage = storage('legacy')

/**
 * Subscription lifecycle for event sources and semantic processors.
 *
 * Unlike Plugin, this class owns no integration identity, tracing semantics,
 * configuration merging, or package-specific processing.
 */
class EventComponent {
  constructor () {
    this._bindings = []
    this._subscriptions = []
    this._enabled = false
  }

  /**
   * Subscribe to a lifecycle channel while this component is enabled.
   *
   * @param {string|import('diagnostics_channel').Channel} channel Channel or channel name.
   * @param {(message: object, name: string) => unknown} handler Event handler.
   * @returns {void}
   */
  addSub (channel, handler) {
    channel = typeof channel === 'string' ? dc.channel(channel) : channel
    const wrapped = (message, name) => {
      if (legacyStorage.getHandle()?.noop) return

      try {
        return handler(message, name)
      } catch (error) {
        this._disableAfterError(error)
      }
    }
    this._subscriptions.push({ channel, handler: wrapped })
  }

  /**
   * Bind legacy storage to a lifecycle start channel.
   *
   * @param {string|import('diagnostics_channel').Channel} channel Channel or channel name.
   * @param {(message: object) => object|undefined} transform Store transform.
   * @returns {void}
   */
  addBind (channel, transform) {
    channel = typeof channel === 'string' ? dc.channel(channel) : channel
    const wrapped = message => {
      const handle = legacyStorage.getHandle()
      if (handle?.noop && !(message && Object.hasOwn(message, 'currentStore'))) {
        return legacyStorage.getStore()
      }

      try {
        return transform(message)
      } catch (error) {
        this._disableAfterError(error)
        return legacyStorage.getStore()
      }
    }
    this._bindings.push({ channel, transform: wrapped })
  }

  /**
   * Enable or disable this component's channel lifecycle.
   *
   * @param {boolean|{enabled?: boolean}} config Component state.
   * @returns {void}
   */
  configure (config) {
    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false
    if (enabled === this._enabled) return

    this._enabled = enabled
    for (const { channel, handler } of this._subscriptions) {
      if (enabled) channel.subscribe(handler)
      else channel.unsubscribe(handler)
    }
    for (const { channel, transform } of this._bindings) {
      if (enabled) channel.bindStore(legacyStorage, transform)
      else channel.unbindStore(legacyStorage)
    }
  }

  _disableAfterError (error) {
    logger.error('Error in event component:', error)
    logger.info('Disabling event component: %s', this.constructor.name)
    this.configure(false)
  }
}

module.exports = EventComponent
