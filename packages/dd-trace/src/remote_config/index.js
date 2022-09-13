'use strict'

const Scheduler = require('../exporters/scheduler')
const request = require('../exporters/common/request')
const uuid = require('crypto-randomuuid')
const { EventEmitter } = require('events')

const clientId = uuid()

const pollInterval = 5e3

// The Client.ClientState field in  ClientGetConfigsRequest MUST contain the global state of RC in the tracer.
// There MUST NOT exist separate instances of RC clients in a tracer making separate ClientGetConfigsRequest with their own separated Client.ClientState.

class RemoteConfigManager extends EventEmitter {
  constructor (config, tracer) {
    super()

    this.config = config
    this.tracer = tracer
    this.scheduler = new Scheduler(() => this.poll(), pollInterval)

    this.state = {
      client: {
        state: {
          root_version: 1,
          targets_version: 0, // MUST be set to the latest applied version of the targets field in ClientGetConfigsResponse. See step 2 and 3 of the update procedure.
          config_states: [
            // MUST include all the configurations applied by the tracer. Configurations that are ignored because they are expired or don’t target that specific tracer MUST NOT be included.
          ],
          has_error: false,
          error: '',
          backend_client_state: ''
        },
        id: clientId,
        products: ['FEATURES', 'ASM', 'ASM_DD', 'ASM_DATA'],
        is_tracer: true,
        client_tracer: {
          runtime_id: this.config.tags['runtime-id'],
          language: 'node',
          tracer_version: '3.0.0',
          service: this.config.service,
          env: this.config.env,
          app_version: this.config.version
        }
      },
      cached_target_files: [
        {
          path: '',
          length: '',
          hashes: ''
        }
      ]
    }

    this.appliedConfig = new Map()
    this.confCache = new Map()
  }

  start () {
    this.scheduler.start()
  }

  stop () {
    this.scheduler.stop()
  }

  poll () {
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

    request(data, options, true, (err, data, statusCode) => {
      statusCode = 200
      err = null
      data = '{"targets": "eyJzaWduZWQiOnsiX3R5cGUiOiJ0YXJnZXRzIiwiY3VzdG9tIjp7Im9wYXF1ZV9iYWNrZW5kX3N0YXRlIjoiZXlKbWIyOGlPaUFpWW1GeUluMD0ifSwiZXhwaXJlcyI6IjIwMjItMTEtMDNUMTg6MDE6MzJaIiwic3BlY192ZXJzaW9uIjoiMS4wIiwidGFyZ2V0cyI6eyJkYXRhZG9nLzIvRkVBVFVSRVMvRkVBVFVSRVMtYmFzZS9jb25maWciOnsiY3VzdG9tIjp7InYiOjF9LCJoYXNoZXMiOnsic2hhMjU2IjoiOTIyMWRmZDlmNjA4NDE1MTMxM2UzZTQ5MjAxMjFhZTg0MzYxNGMzMjhlNDYzMGVhMzcxYmE2NmUyZjE1YTBhNiJ9LCJsZW5ndGgiOjQ3fX0sInZlcnNpb24iOjJ9LCJzaWduYXR1cmVzIjpbeyJrZXlpZCI6ImVkNzY3MmM5YTI0YWJkYTc4ODcyZWUzMmVlNzFjN2NiMWQ1MjM1ZThkYjRlY2JmMWNhMjhiOWM1MGViNzVkOWUiLCJzaWciOiIyMzMwOWE3YjdlMzExOTFiMjk0MGEzYzlhNGE4ZmE2ODIxNWI1Y2I1OGEwYjc5NDcxN2ZmOWMxYzgyZjI3NDcwMmM1NzRmYWI5MjZjMzI1MDI4MjE4OTNlM2IyMGY1ZGE4NjU1OGE1YjNmNmJkMTYxMzQ1ZDYyNWI1Nzg0OTQwZCJ9XX0=", "target_files": [{"path": "datadog/2/FEATURES/FEATURES-base/config", "raw": "ewogICAgImFzbSI6IHsKICAgICAgICAiZW5hYmxlZCI6IHRydWUKICAgIH0KfQo="}], "client_configs": ["datadog/2/FEATURES/FEATURES-base/config"]}'

      if (statusCode === 404) {
        // feature is disabled, ignore it...
        return
      }

      if (err) {
        return
      }

      if (data) {
        this.parseConfig(JSON.parse(data))
      }
    })
  }

  parseConfig (data) {
    let { client_configs, targets, target_files } = data

    targets = fromBase64(targets)

    const toUnapply = Array.from(this.appliedConfig.keys()).filter((path) => !client_configs.includes(path))
    const toApply = []
    const toModify = []

    client_configs = client_configs || []

    for (const path of client_configs) {
      const meta = targets.signed.targets[path]

      if (!meta) throw new Error('No target found')

      const current = this.appliedConfig.get(path)

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

const configPathRegex = new RegExp('^(?:datadog\\/\\d+|employee)\\/([^/]+)\\/([^/]+)\\/[^/]+$')

function parseConfigPath (configPath) {
  const result = {}

  const match = configPathRegex.exec(configPath)

  if (!match) return result
  if (match[1]) result.product = match[1]
  if (match[2]) result.id = match[2]

  return result
}

module.exports = RemoteConfigManager
