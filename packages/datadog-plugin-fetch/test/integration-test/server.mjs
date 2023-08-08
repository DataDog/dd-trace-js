import 'dd-trace/init.js'
import getPort from 'get-port'

const port = await getPort()

global.fetch(`http://localhost:${port}/foo`)
  .then((response) => {})
  .then((data) => {})
  .catch((err) => {})
