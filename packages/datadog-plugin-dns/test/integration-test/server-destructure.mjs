import 'dd-trace/init.js'
import { lookup } from 'dns'
const dns = { lookup }

dns.lookup('fakedomain.faketld', { all: true }, (err, address, family) => {})

