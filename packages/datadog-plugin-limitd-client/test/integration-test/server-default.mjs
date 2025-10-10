import 'dd-trace/init.js'
import LimitdClient from 'limitd-client'

const limitd = new LimitdClient('limitd://127.0.0.1:9231', function (err, resp) {})

limitd.take('user', 'test', () => {})

limitd.disconnect()

