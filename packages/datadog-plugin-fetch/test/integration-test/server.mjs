import 'dd-trace/init.js'

global.fetch('http://localhost:0/foo')
  .then((response) => {})
  .then((data) => {})
  .catch((err) => {})
