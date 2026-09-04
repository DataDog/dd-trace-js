// Match the generated function name in WebDriver's published bundle.
// eslint-disable-next-line camelcase
function command_default (method, endpoint, commandInfo) {
  const { command } = commandInfo

  return async function protocolCommand (...args) {
    let runtimeOptions = {}
    runtimeOptions = args.at(-1) ?? runtimeOptions
    this.calls.push(command)
    let value = { args, endpoint, method, runtimeOptions }
    if (command === 'getWindowHandles') value = this.windowHandles
    if (command === 'closeWindow') {
      this.windowHandles = this.windowHandles.slice(0, -1)
      value = this.windowHandles
    }
    this.emit?.('result', { command, result: { value } })
    return value
  }
}

class BidiHandler {
  attachClient (client) {
    this.client = client
  }

  async browsingContextNavigate (...args) {
    this.client.calls.push('browsingContextNavigate')
    return { args }
  }
}

function initiateBidi () {
  const handler = new BidiHandler()

  return {
    _bidiHandler: { value: handler },
    browsingContextNavigate: {
      value: function (...args) {
        const bidiFn = handler.browsingContextNavigate
        handler.attachClient(this)
        return bidiFn.apply(handler, args)
      },
    },
  }
}

const closeWindow = command_default('DELETE', '/session/:sessionId/window', { command: 'closeWindow' })
const deleteSession = command_default('DELETE', '/session/:sessionId', { command: 'deleteSession' })
const getTitle = command_default('GET', '/session/:sessionId/title', { command: 'getTitle' })
const getWindowHandles = command_default('GET', '/session/:sessionId/window/handles', { command: 'getWindowHandles' })
const navigateTo = command_default('POST', '/session/:sessionId/url', { command: 'navigateTo' })

export { closeWindow, deleteSession, getTitle, getWindowHandles, initiateBidi, navigateTo }
