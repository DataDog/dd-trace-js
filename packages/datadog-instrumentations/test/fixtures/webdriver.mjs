// Match the generated function name in WebDriver's published bundle.
// eslint-disable-next-line camelcase
function command_default (method, endpoint, commandInfo) {
  const { command } = commandInfo

  return async function protocolCommand (...args) {
    let runtimeOptions = {}
    runtimeOptions = args.at(-1) ?? runtimeOptions
    this.calls.push(command)
    this.emit?.('result', { command })
    return { args, endpoint, method, runtimeOptions }
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

const deleteSession = command_default('DELETE', '/session/:sessionId', { command: 'deleteSession' })
const getTitle = command_default('GET', '/session/:sessionId/title', { command: 'getTitle' })
const navigateTo = command_default('POST', '/session/:sessionId/url', { command: 'navigateTo' })

export { deleteSession, getTitle, initiateBidi, navigateTo }
