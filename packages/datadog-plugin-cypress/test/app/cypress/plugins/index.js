// TODO: Remove `urlToHttpOptions` polyfill once we drop support for the older Cypress versions that uses a built-in
// version of Node.js doesn't include that function.
const url = require('url')
if (url.urlToHttpOptions === undefined) {
  url.urlToHttpOptions = (url) => {
    const { hostname, pathname, port, username, password, search } = url
    const options = {
      __proto__: null,
      ...url, // In case the url object was extended by the user.
      protocol: url.protocol,
      hostname: typeof hostname === 'string' && hostname.startsWith('[')
        ? hostname.slice(1, -1)
        : hostname,
      hash: url.hash,
      search,
      pathname,
      path: `${pathname || ''}${search || ''}`,
      href: url.href
    }
    if (port !== '') {
      options.port = Number(port)
    }
    if (username || password) {
      options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`
    }
    return options
  }
}

module.exports = (on, config) => {
  // We can't use the tracer available in the testing process, because this code is
  // run in a different process. We need to init a different tracer reporting to the
  // url set by the plugin agent
  require('../../../../../dd-trace').init({ startupLogs: false })
  require('../../../../src/plugin')(on, config)
}
