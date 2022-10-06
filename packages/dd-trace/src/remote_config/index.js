'use strict'

const uuid = require('crypto-randomuuid')
const { EventEmitter } = require('events')
const Scheduler = require('./scheduler')
const tracerVersion = require('../../../../package.json').version
const request = require('../exporters/common/request')
const log = require('../log')

const clientId = uuid()

const POLL_INTERVAL = 5e3

// There MUST NOT exist separate instances of RC clients in a tracer making separate ClientGetConfigsRequest
// with their own separated Client.ClientState.
class RemoteConfigManager extends EventEmitter {
  constructor (config) {
    super()

    this.scheduler = new Scheduler((cb) => this.poll(cb), POLL_INTERVAL)

    this.requestOptions = {
      url: config.url,
      // TODO: do we need hostname/port here ?
      path: '/v0.7/config',
      method: 'POST'
    }

    this.state = {
      client: {
        state: { // updated by `parseConfig()`
          root_version: 1,
          targets_version: 0,
          config_states: [],
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
          app_version: config.version
        },
        capabilities: 'AA==' // updated by `updateCapabilities()`
      },
      cached_target_files: [] // updated by `parseConfig()`
    }

    this.appliedConfigs = new Map()
    this.confCache = new Map()

    this.on('newListener', this.updateProducts)
    this.on('removeListener', this.updateProducts)
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

  updateProducts () {
    // this is needed because newListener fires before eventNames() is updated
    process.nextTick(() => {
      this.state.client.products = this.eventNames().slice(2) // omit newListener and removeListener
    })
  }

  start () {
    this.scheduler.start()
  }

  stop () {
    this.scheduler.stop()
  }

  poll (cb) {
    request(JSON.stringify(this.state), this.requestOptions, (err, data, statusCode) => {
      // 404 means RC is disabled, ignore it
      if (statusCode === 404) return cb()

      if (err) {
        log.error(err)
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
          log.error(`Could not parse remote config response: ${err}`)

          this.state.client.state.has_error = true
          this.state.client.state.error = err.toString()
        }
      }

      cb()
    })
  }

  parseConfig (data) {
    // `client_configs` is the list of config paths to apply
    // `targets` is the signed index with metadata for config files
    // `target_files` is the list of config files containing the actual config data
    let { client_configs, targets, target_files } = data

    targets = fromBase64(targets)

    const toUnapply = Array.from(this.appliedConfigs.keys()).filter((path) => !client_configs.includes(path))
    const toApply = []
    const toModify = []

    client_configs = client_configs || []

    // TODO: verify signatures
    // TODO: meta.signed.expires ?

    for (const path of client_configs) {
      const meta = targets.signed.targets[path]
      if (!meta) throw new Error(`Unable to find target for path ${path}`)

      const current = this.appliedConfigs.get(path)

      if (!current) toApply.push(path)
      else if (current.hashes.sha256 !== meta.hashes.sha256) toModify.push(path)
      else continue

      let file = this.confCache.get(meta.hashes.sha256) || target_files.find(file => file.path === path)
      if (!file) throw new Error('No file found')

      file = fromBase64(file.raw)

      const { product, id } = parseConfigPath(path)

      if (!product || !id) throw new Error('Cant parse path')

      this.appliedConfig.set(path, {
        path,
        product,
        id,
        hashes: meta.hashes
      })

      this.confCache.set(meta.hashes.sha256, file)
    }


    this.state.client.state.backend_client_state = targets.signed.custom.opaque_backend_state

    // save

    // remove unapplied caches

    this.dispatch(toUnapply, 'disable')
    this.dispatch(toApply, 'enable')
    this.dispatch(toModify, 'modify')
  }

  dispatch (list, action) {
    for (let item of list) {
      item = this.appliedConfig.get(item)
      this.emit(item.product, action, item, this.confCache.get(item.hashes.sha256))
    }
  }
}

function fromBase64 (str) {
  return JSON.parse(Buffer.from(str, 'base64').toString())
}

const configPathRegex = /^(?:datadog\/\d+|employee)\/([^/]+)\/([^/]+)\/[^/]+$/

function parseConfigPath (configPath) {
  const match = configPathRegex.exec(configPath)

  if (!match || !match[1] || !match[2]) {
    throw new Error('Cant parse path')
  }

  return {
    product: match[1],
    id: match[2]
  }
}

module.exports = RemoteConfigManager
