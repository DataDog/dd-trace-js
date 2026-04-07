const http = require('http')
const agent = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}') }) })
agent.listen(8126, () => {
  const tracer = require('./packages/dd-trace').init({ hostname:'127.0.0.1', port:8126, flushInterval:0, plugins:false })
  tracer.use('http'); tracer.use('express')
  const express = require('express')
  const app = express()
  app.use((req,res,next)=>{const s=tracer.scope().active();if(s)s.setTag('auth','u');next()})
  app.get('/api/users/:id',(req,res)=>{
    const span=tracer.startSpan('db',{childOf:tracer.scope().active(),tags:{'service.name':'pg','resource.name':'SELECT','span.type':'sql','db.type':'pg'}})
    setTimeout(()=>{span.setTag('db.rows',1);span.finish();res.json({id:req.params.id})},1)
  })
  app.get('/api/health',(req,res)=>res.json({ok:true}))
  const server=app.listen(0,()=>{
    const port=server.address().port;let done=0,fly=0;let batchStart=Date.now()
    function go(){if(done>=30000)return;if(fly>=20)return;fly++
      http.get({hostname:'127.0.0.1',port,path:done%5===0?'/api/health':'/api/users/'+(done%100+1)},(res)=>{
        res.resume();res.on('end',()=>{fly--;done++
          if(done%5000===0){const elapsed=Date.now()-batchStart;process.stderr.write(done+': '+Math.round(5000/elapsed*1000)+' req/s, rss='+Math.round(process.memoryUsage().rss/1024/1024)+'MB\n');batchStart=Date.now()}
          if(done>=30000){server.close();agent.close();setTimeout(()=>process.exit(),500);return}
          setImmediate(go)
        })
      }).on('error',()=>{fly--;done++;setImmediate(go)})
      setImmediate(go)
    }
    for(let i=0;i<20;i++)go()
  })
})
