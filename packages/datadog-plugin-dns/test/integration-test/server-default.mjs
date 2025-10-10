import 'dd-trace/init.js'
import dns from 'dns'

dns.lookup('fakedomain.faketld', { all: true }, (err, address, family) => {})

