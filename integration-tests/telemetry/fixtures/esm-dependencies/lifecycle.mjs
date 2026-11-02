import assert from 'node:assert/strict'
import dc from 'node:diagnostics_channel'

const events = []
const start = dc.channel('dd-trace:moduleLoadStart')
const end = dc.channel('dd-trace:moduleLoadEnd')
const onLoad = ({ filename }) => {
  if (filename?.includes('/node_modules/nanoid/')) events.push(filename)
}

start.subscribe(onLoad)
end.subscribe(onLoad)

try {
  await import('nanoid')
  const { nanoid } = await import('nanoid/non-secure')
  const { default: axios } = await import('axios')
  assert.deepStrictEqual(events, [])
  assert.strictEqual(nanoid(10).length, 10)
  assert.strictEqual(typeof axios.get, 'function')
} finally {
  start.unsubscribe(onLoad)
  end.unsubscribe(onLoad)
}
