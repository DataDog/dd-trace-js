import 'dd-trace/init.js'

global.fetch('http://localhost:55555/foo')
  .then((response) => {})
  .then((data) => {})
  .catch((err) => {})
