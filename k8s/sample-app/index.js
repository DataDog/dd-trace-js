console.log(process.env)
console.log(Object.keys(require.cache).filter(x => x.includes('dd-trace')))

require('http').createServer((req, res) => {
  res.end('Hello, world!\n')
}).listen(18080, () => {
  console.log('listening on port 18080')
})
