'use strict'

global.gc = () => {
  throw new Error('unexpected forced garbage collection')
}
