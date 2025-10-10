import 'dd-trace/init.js'
import * as modlimitdclient from 'limitd-client'
const LimitdClient = modlimitdclient.default

const limitd = new LimitdClient('limitd://127.0.0.1:9231', function (err, resp) {})

limitd.take('user', 'test', () => {})

limitd.disconnect()

