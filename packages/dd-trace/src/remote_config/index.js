'use strict'

const uuid = require('crypto-randomuuid')
const { EventEmitter } = require('events')
const Scheduler = require('../exporters/scheduler')
const tracerVersion = require('../../../../package.json').version
const request = require('../exporters/common/request')
const log = require('../log')

const clientId = uuid()

const POLL_INTERVAL = 5e3

// There MUST NOT exist separate instances of RC clients in a tracer making separate ClientGetConfigsRequest with their own separated Client.ClientState.

class RemoteConfigManager extends EventEmitter {
  constructor (config, tracer) {
    super()

    this.tracer = tracer
    this.scheduler = new Scheduler(() => this.poll(), POLL_INTERVAL)

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
        capabilities: [0, 0, 0, 0] // updated by `updateCapabilities()`
      },
      cached_target_files: [] // updated by `parseConfig()`
    }

    this.appliedConfigs = new Map()
    this.confCache = new Map()

    this.on('newListener', this.updateProducts)
    this.on('removeListener', this.updateProducts)
  }

  updateCapabilities(mask, value) {
    const arr = new Uint8Array(this.state.client.capabilities)

    const view = new DataView(arr.buffer)

    let num = view.getUint32()

    // set the bit in `num` at `mask` to `value`
    num ^= (-value ^ num) & mask

    view.setUint32(0, num)

    this.state.client.capabilities = Array.from(arr)
  }

  updateProducts() {
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
    const data = JSON.stringify(this.state)

    const options = {
      path: '/v0.7/config',
      method: 'POST'
    }

    const url = this.tracer._tracer._exporter._url

    if (url.protocol === 'unix:') {
      options.socketPath = url.pathname
    } else {
      options.protocol = url.protocol
      options.hostname = url.hostname
      options.port = url.port
    }

    request(data, options, (err, data, statusCode) => {
      if (statusCode !== 404) { // 404 means RC is disabled, ignore it
      if (err) {
          log.error(err)
        } else {
          if (this.state.client.has_error) {
            this.state.client.has_error = false
            this.state.client.error = ''
      }

          if (data && data !== '{}') { // '{}' means the tracer is up to date
            try {
        this.parseConfig(JSON.parse(data))
            } catch (err) {
              log.error(`Could not parse remote config response: ${err}`)

              this.state.client.has_error = true
              this.state.client.error = err.toString()
      }
          }
        }
      }

      cb && cb()
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

      if (!meta) throw new Error('No target found')

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
  const result = {}

  const match = configPathRegex.exec(configPath)

  if (match) {
    if (match[1]) result.product = match[1]
    if (match[2]) result.id = match[2]
  }

  return result
}

module.exports = RemoteConfigManager
