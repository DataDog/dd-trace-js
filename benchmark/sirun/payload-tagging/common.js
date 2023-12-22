module.exports = {
  port: 11000 + parseInt(process.env.CPU_AFFINITY || '0'),
  reqs: 350
}
