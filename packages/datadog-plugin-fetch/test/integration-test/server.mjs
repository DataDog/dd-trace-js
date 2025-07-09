import 'dd-trace/init.js'

// An arbitrary port is used here as we just need a request even if it fails.
global.fetch('http://localhost:55555/foo')
  .then((response) => {})
  .then((data) => {})
  .catch((err) => {})
