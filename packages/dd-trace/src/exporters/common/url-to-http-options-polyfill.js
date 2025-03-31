'use strict'

const { urlToHttpOptions } = require('url')

// TODO: Remove `urlToHttpOptions` polyfill once we drop support for the older Cypress versions that uses a built-in
// version of Node.js doesn't include that function.
module.exports = {
  urlToHttpOptions: urlToHttpOptions ?? function (url) {
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
