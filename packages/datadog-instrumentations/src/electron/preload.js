'use strict'

// eslint-disable-next-line n/no-missing-require
const { contextBridge, ipcRenderer } = require('electron')

const BRIDGE_CHANNEL = 'datadog:bridge-send'
const CONFIG_CHANNEL = 'datadog:bridge-config'
const RENDERER_SPAN_CHANNEL = 'datadog:apm:renderer:span'

// Privacy levels matching @datadog/browser-core DefaultPrivacyLevel
const MASK = 'mask'

const config = ipcRenderer.sendSync(CONFIG_CHANNEL)

const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? MASK
const configuredHosts = config?.allowedWebViewHosts ?? []
// eslint-disable-next-line no-undef
const allowedHosts = [...new Set([location.hostname, ...configuredHosts])]

// RUM context provider registered by the browser-sdk (or directly by app code)
let getRumContext = null

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateHexId () {
  // eslint-disable-next-line no-undef
  const buf = new Uint8Array(8)
  // eslint-disable-next-line no-undef
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

function makeCarrier (traceIdHex, spanIdHex) {
  return {
    'x-datadog-trace-id': BigInt('0x' + traceIdHex).toString(10),
    'x-datadog-parent-id': BigInt('0x' + spanIdHex).toString(10),
    'x-datadog-sampling-priority': '1',
  }
}

function hexFromDecimal (decimal) {
  return BigInt(decimal).toString(16).padStart(16, '0')
}

function extractCarrier (args) {
  const last = args[args.length - 1]
  if (last !== null && typeof last === 'object' && 'x-datadog-trace-id' in last) {
    args.pop()
    return last
  }
  return null
}

function reportSpan (metadata) {
  ipcRenderer.send(RENDERER_SPAN_CHANNEL, metadata)
}

// ── ipcRenderer.invoke wrapper (Renderer → Main) ─────────────────────────────

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer)
ipcRenderer.invoke = (channel, ...args) => {
  if (channel.startsWith('datadog:')) {
    return originalInvoke(channel, ...args)
  }

  const traceId = generateHexId()
  const spanId = generateHexId()
  const startTime = Date.now()
  const rumContext = getRumContext?.(startTime)
  const carrier = makeCarrier(traceId, spanId)

  return originalInvoke(channel, ...args, carrier).then(
    (result) => {
      reportSpan({ type: 'renderer.invoke', channel, traceId, spanId, startTime, endTime: Date.now(), pid: process.pid, rumContext })
      return result
    },
    (err) => {
      reportSpan({ type: 'renderer.invoke', channel, traceId, spanId, startTime, endTime: Date.now(), pid: process.pid, rumContext, error: true })
      throw err
    }
  )
}

// ── ipcRenderer.on wrapper (Main → Renderer) ──────────────────────────────────

const originalOn = ipcRenderer.on.bind(ipcRenderer)
ipcRenderer.on = (channel, listener) => {
  if (channel.startsWith('datadog:')) {
    return originalOn(channel, listener)
  }

  const wrapped = (event, ...args) => {
    const carrier = extractCarrier(args)
    const parentSpanId = carrier?.['x-datadog-parent-id']
      ? hexFromDecimal(carrier['x-datadog-parent-id'])
      : undefined
    const traceId = carrier?.['x-datadog-trace-id']
      ? hexFromDecimal(carrier['x-datadog-trace-id'])
      : generateHexId()
    const spanId = generateHexId()
    const startTime = Date.now()
    const rumContext = getRumContext?.(startTime)

    const finish = (endTime) =>
      reportSpan({ type: 'renderer.receive', channel, traceId, spanId, parentSpanId, startTime, endTime, pid: process.pid, rumContext })

    const result = listener(event, ...args)
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(() => finish(Date.now()), () => finish(Date.now()))
    } else {
      finish(Date.now())
    }
    return result
  }

  return originalOn(channel, wrapped)
}

// Signal to the main process that this renderer supports trace context injection.
// This enables ElectronMainSendPlugin to inject carriers into webContents.send calls to this renderer.
ipcRenderer.send('datadog:apm:renderer:patched')

// ── DatadogEventBridge ────────────────────────────────────────────────────────

const bridge = {
  getCapabilities () {
    return '[]'
  },
  getPrivacyLevel () {
    return defaultPrivacyLevel
  },
  getAllowedWebViewHosts () {
    return JSON.stringify(allowedHosts)
  },
  send (msg) {
    ipcRenderer.send(BRIDGE_CHANNEL, msg)
  },
  /**
   * Called by the browser-sdk (or app code) to register a callback that returns
   * the RUM context (view.id, action.id) active at the given start time as a JSON string.
   * The preload calls this callback synchronously at IPC interception time.
   * @param {(startTime: number) => string} fn
   */
  registerRumContextProvider (fn) {
    getRumContext = fn
  },
}

// Support both contextIsolation enabled (default) and disabled

window.DatadogEventBridge = bridge

try {
  contextBridge.exposeInMainWorld('DatadogEventBridge', bridge)
} catch {
  // exposeInMainWorld throws when contextIsolation is disabled
}
