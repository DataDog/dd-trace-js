'use strict'

const { URL, format } = require('url')
const uuid = require('crypto-randomuuid')
const { EventEmitter } = require('events')
const tracerVersion = require('../../../../../package.json').version
const request = require('../../exporters/common/request')
const log = require('../../log')
const { getExtraServices } = require('../../service-naming/extra-services')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('./apply_states')
const Scheduler = require('./scheduler')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../../plugins/util/tags')

const clientId = uuid()

const DEFAULT_CAPABILITY = Buffer.alloc(1).toString('base64') // 0x00

const kPreUpdate = Symbol('kPreUpdate')
const kSupportsAckCallback = Symbol('kSupportsAckCallback')

// There MUST NOT exist separate instances of RC clients in a tracer making separate ClientGetConfigsRequest
// with their own separated Client.ClientState.
class RemoteConfigManager extends EventEmitter {
  static get kPreUpdate () { return kPreUpdate }

  constructor (config) {
    super()

    const pollInterval = Math.floor(config.remoteConfig.pollInterval * 1000)

    this.url = config.url || new URL(format({
      protocol: 'http:',
      hostname: config.hostname || 'localhost',
      port: config.port
    }))

    const tags = config.repositoryUrl
      ? {
          ...config.tags,
          [GIT_REPOSITORY_URL]: config.repositoryUrl,
          [GIT_COMMIT_SHA]: config.commitSHA
        }
      : config.tags

    this._handlers = new Map()
    const appliedConfigs = this.appliedConfigs = new Map()

    this.scheduler = new Scheduler((cb) => this.poll(cb), pollInterval)

    this.state = {
      client: {
        state: { // updated by `parseConfig()` and `poll()`
          root_version: 1,
          targets_version: 0,
          // Use getter so `apply_*` can be updated async and still affect the content of `config_states`
          get config_states () {
            return Array.from(appliedConfigs.values()).map((conf) => ({
              id: conf.id,
              version: conf.version,
              product: conf.product,
              apply_state: conf.apply_state,
              apply_error: conf.apply_error
            }))
          },
          has_error: false,
          error: '',
          backend_client_state: ''
        },
        id: clientId,
        products: [], // updated by `updateProducts()`
        is_tracer: true,
        client_tracer: {
          runtime_id: config.tags['runtime-id'],
          language: 'node',
          tracer_version: tracerVersion,
          service: config.service,
          env: config.env,
          app_version: config.version,
          extra_services: [],
          tags: Object.entries(tags).map((pair) => pair.join(':'))
        },
        capabilities: DEFAULT_CAPABILITY // updated by `updateCapabilities()`
      },
      cached_target_files: [] // updated by `parseConfig()`
    }
  }

  updateCapabilities (mask, value) {
    const hex = Buffer.from(this.state.client.capabilities, 'base64').toString('hex')

    let num = BigInt(`0x${hex}`)

    if (value) {
      num |= mask
    } else {
      num &= ~mask
    }

    let str = num.toString(16)

    if (str.length % 2) str = `0${str}`

    this.state.client.capabilities = Buffer.from(str, 'hex').toString('base64')
  }

  setProductHandler (product, handler) {
    this._handlers.set(product, handler)
    this.updateProducts()
    if (this.state.client.products.length === 1) {
      this.scheduler.start()
    }
  }

  removeProductHandler (product) {
    this._handlers.delete(product)
    this.updateProducts()
    if (this.state.client.products.length === 0) {
      this.scheduler.stop()
    }
  }

  updateProducts () {
    this.state.client.products = Array.from(this._handlers.keys())
  }

  getPayload () {
    this.state.client.client_tracer.extra_services = getExtraServices()

    return JSON.stringify(this.state)
  }

  poll (cb) {
    const options = {
      url: this.url,
      method: 'POST',
      path: '/v0.7/config',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    }

    request(this.getPayload(), options, (err, data, statusCode) => {
      // 404 means RC is disabled, ignore it
      if (statusCode === 404) return cb()

      if (err) {
        log.error('[RC] Error in request', err)
        return cb()
      }

      // if error was just sent, reset the state
      if (this.state.client.state.has_error) {
        this.state.client.state.has_error = false
        this.state.client.state.error = ''
      }

      if (data && data !== '{}') { // '{}' means the tracer is up to date
        try {
          this.parseConfig(JSON.parse(data))
        } catch (err) {
          log.error('[RC] Could not parse remote config response', err)

          this.state.client.state.has_error = true
          this.state.client.state.error = err.toString()
        }
      }

      cb()
    })
  }

  // `client_configs` is the list of config paths to have applied
  // `targets` is the signed index with metadata for config files
  // `target_files` is the list of config files containing the actual config data
  parseConfig ({
    client_configs: clientConfigs = [],
    targets,
    target_files: targetFiles = []
  }) {
    const toUnapply = []
    const toApply = []
    const toModify = []

    for (const appliedConfig of this.appliedConfigs.values()) {
      if (!clientConfigs.includes(appliedConfig.path)) {
        toUnapply.push(appliedConfig)
      }
    }

    targets = fromBase64JSON(targets)

    if (targets) {
      for (const path of clientConfigs) {
        const meta = targets.signed.targets[path]
        if (!meta) throw new Error(`Unable to find target for path ${path}`)

        const current = this.appliedConfigs.get(path)

        const newConf = {}

        if (current) {
          if (current.hashes.sha256 === meta.hashes.sha256) continue

          toModify.push(newConf)
        } else {
          toApply.push(newConf)
        }

        const file = targetFiles.find(file => file.path === path)
        if (!file) throw new Error(`Unable to find file for path ${path}`)

        // TODO: verify signatures
        //       verify length
        //       verify hash
        //       verify _type
        // TODO: new Date(meta.signed.expires) ignore the Targets data if it has expired ?

        const { product, id } = parseConfigPath(path)

        Object.assign(newConf, {
          path,
          product,
          id,
          version: meta.custom.v,
          apply_state: UNACKNOWLEDGED,
          apply_error: '',
          length: meta.length,
          hashes: meta.hashes,
          file: fromBase64JSON(file.raw)
        })
      }

      this.state.client.state.targets_version = targets.signed.version
      this.state.client.state.backend_client_state = targets.signed.custom.opaque_backend_state
    }

    if (toUnapply.length || toApply.length || toModify.length) {
      this.emit(RemoteConfigManager.kPreUpdate, { toUnapply, toApply, toModify })

      this.dispatch(toUnapply, 'unapply')
      this.dispatch(toApply, 'apply')
      this.dispatch(toModify, 'modify')

      this.state.cached_target_files = Array.from(this.appliedConfigs.values()).map((conf) => ({
        path: conf.path,
        length: conf.length,
        hashes: Object.entries(conf.hashes).map((entry) => ({ algorithm: entry[0], hash: entry[1] }))
      }))
    }
  }

  dispatch (list, action) {
    for (const item of list) {
      // TODO: we need a way to tell if unapply configs were handled by kPreUpdate or not, because they're always
      // emitted unlike the apply and modify configs

      this._callHandlerFor(action, item)

      if (action === 'unapply') {
        this.appliedConfigs.delete(item.path)
      } else {
        this.appliedConfigs.set(item.path, item)
      }
    }
  }

  _callHandlerFor (action, item) {
    // in case the item was already handled by kPreUpdate
    if (item.apply_state !== UNACKNOWLEDGED && action !== 'unapply') return

    const handler = this._handlers.get(item.product)

    if (!handler) return

    try {
      if (supportsAckCallback(handler)) {
        // If the handler accepts an `ack` callback, expect that to be called and set `apply_state` accordinly
        // TODO: do we want to pass old and new config ?
        handler(action, item.file, item.id, (err) => {
          if (err) {
            item.apply_state = ERROR
            item.apply_error = err.toString()
          } else if (item.apply_state !== ERROR) {
            item.apply_state = ACKNOWLEDGED
          }
        })
      } else {
        // If the handler doesn't accept an `ack` callback, assume `apply_state` is `ACKNOWLEDGED`,
        // unless it returns a promise, in which case we wait for the promise to be resolved or rejected.
        // TODO: do we want to pass old and new config ?
        const result = handler(action, item.file, item.id)
        if (result instanceof Promise) {
          result.then(
            () => { item.apply_state = ACKNOWLEDGED },
            (err) => {
              item.apply_state = ERROR
              item.apply_error = err.toString()
            }
          )
        } else {
          item.apply_state = ACKNOWLEDGED
        }
      }
    } catch (err) {
      item.apply_state = ERROR
      item.apply_error = err.toString()
    }
  }
}

function fromBase64JSON (str) {
  if (!str) return null

  return JSON.parse(Buffer.from(str, 'base64').toString())
}

const configPathRegex = /^(?:datadog\/\d+|employee)\/([^/]+)\/([^/]+)\/[^/]+$/

function parseConfigPath (configPath) {
  const match = configPathRegex.exec(configPath)

  if (!match || !match[1] || !match[2]) {
    throw new Error(`Unable to parse path ${configPath}`)
  }

  return {
    product: match[1],
    id: match[2]
  }
}

function supportsAckCallback (handler) {
  if (kSupportsAckCallback in handler) return handler[kSupportsAckCallback]

  const numOfArgs = handler.length
  let result = false

  if (numOfArgs >= 4) {
    result = true
  } else if (numOfArgs !== 0) {
    const source = handler.toString()
    result = source.slice(0, source.indexOf(')')).includes('...')
  }

  handler[kSupportsAckCallback] = result

  return result
}

module.exports = RemoteConfigManager
