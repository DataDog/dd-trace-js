import 'dd-trace/init.js'
import axios from 'axios'

// An arbitrary port is used here as we just need a request even if it fails.
axios.get('http://localhost:55555/foo')
  .then(() => {})
  .catch(() => {})
  .finally(() => {})
