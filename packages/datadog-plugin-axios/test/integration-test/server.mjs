import 'dd-trace/init.js'
import axios from 'axios'

axios.get('/foo')
  .then(() => {})
  .catch(() => {})
  .finally(() => {})
