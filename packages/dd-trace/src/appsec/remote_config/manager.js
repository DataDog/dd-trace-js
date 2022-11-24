'use strict'

const uuid = require('crypto-randomuuid')
const { EventEmitter } = require('events')
const Scheduler = require('./scheduler')
const tracerVersion = require('../../../../../package.json').version
const request = require('../../exporters/common/request')
const log = require('../../log')

const clientId = uuid()

const DEFAULT_CAPABILITY = Buffer.alloc(1).toString('base64') // 0x00

// There MUST NOT exist separate instances of RC clients in a tracer making separate ClientGetConfigsRequest
// with their own separated Client.ClientState.
class RemoteConfigManager extends EventEmitter {
  constructor (config) {
    super()

    this.scheduler = new Scheduler((cb) => this.poll(cb), config.rcPollingInterval * 1e3)

    this.requestOptions = {
      url: config.url,
      hostname: config.hostname,
      port: config.port,
      method: 'POST',
      path: '/v0.7/config'
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
        capabilities: DEFAULT_CAPABILITY // updated by `updateCapabilities()`
      },
      cached_target_files: [] // updated by `parseConfig()`
    }

    this.appliedConfigs = new Map()
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

  on (event, listener) {
    super.on(event, listener)

    this.state.client.products = this.eventNames()

    this.scheduler.start()

    return this
  }

  off (event, listener) {
    super.off(event, listener)

    this.state.client.products = this.eventNames()

    if (!this.state.client.products.length) {
      this.scheduler.stop()
    }

    return this
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
          apply_state: 1,
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
      this.dispatch(toUnapply, 'unapply')
      this.dispatch(toApply, 'apply')
      this.dispatch(toModify, 'modify')

      this.state.client.state.config_states = []
      this.state.cached_target_files = []

      for (const conf of this.appliedConfigs.values()) {
        this.state.client.state.config_states.push({
          id: conf.id,
          version: conf.version,
          product: conf.product,
          apply_state: conf.apply_state,
          apply_error: conf.apply_error
        })

        this.state.cached_target_files.push({
          path: conf.path,
          length: conf.length,
          hashes: Object.entries(conf.hashes).map((entry) => ({ algorithm: entry[0], hash: entry[1] }))
        })
      }
    }
  }

  dispatch (list, action) {
    for (const item of list) {
      try {
        // TODO: do we want to pass old and new config ?
        this.emit(item.product, action, item.file)

        item.apply_state = 2
      } catch (err) {
        item.apply_state = 3
        item.apply_error = err.toString()
      }

      if (action === 'unapply') {
        this.appliedConfigs.delete(item.path)
      } else {
        this.appliedConfigs.set(item.path, item)
      }
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

module.exports = RemoteConfigManager
