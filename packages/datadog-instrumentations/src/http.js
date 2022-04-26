'use strict'

require('./http/client')
require('./http/server')

if (global.fetch && global.Response) {
  require('./http/fetch')
}
