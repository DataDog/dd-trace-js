import 'dd-trace/init.js'
import DataLoader from 'dataloader'

const loader = new DataLoader(keys => Promise.resolve(keys), { name: 'esm-users' })

await loader.load('key')
