let i = 0
const loadedContexts = new WeakSet()
const loadMap = new Map()
let communicationPort
export async function initialize({ port }) {
  communicationPort = port
  communicationPort.on('message', (msg) => {
    if (msg.id !== undefined) {
      const cb = loadMap.get(msg.id)
      if (cb) {
        cb({ id: msg.id, source: msg.source })
      }
    }
  })
}

export async function load(url, context, nextLoad) {
  const nextLoadResult = await nextLoad(url, context)
  if (nextLoadResult.source && !loadedContexts.has(loadedContexts)) {
    const id = i++
    return new Promise((resolve) => {
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          loadMap.delete(id)
          resolve(nextLoadResult)
        }
      }, 100)
      timeout.unref && timeout.unref()

      loadMap.set(id, ({ source }) => {
        if (!resolved) {
          resolved = true
          nextLoadResult.source = Buffer.from(source)
          clearTimeout(timeout)
          resolve(nextLoadResult)
        }
      })
      communicationPort.postMessage({
        id,
        url,
        source: nextLoadResult.source
      })
    })

  }
  return nextLoadResult
}
