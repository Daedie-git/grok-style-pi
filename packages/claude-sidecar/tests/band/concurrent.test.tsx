import {expect,test,mock} from 'claude-code/testing'

test('coincident idle timer and launcher refresh leave only one polling chain',async($,on)=>{
 let active=false, scans=0
 on('session.start',(_,e)=>({cwd:e.cwd}))
 on('env.get',(_,e)=>({value:e.name==='HOME'?'/fake':e.name==='HERDR_PANE_ID'?'PANE:1':undefined}))
 on('fs.list',(_,e)=>{if(!e.path.includes('/jobs/'))scans++;return {value:active?[{name:'sc-pane-1.request.json',kind:'file',size:0,mtimeMs:0,isLink:false}]:[]}})
 on('fs.read',(_,e)=>({value:e.path.endsWith('request.json')?'{"id":"a-b-ask","started":1}':'reviewer'}))
 on('tool.call',()=>({result:{}}))
 const clock=mock.clock(on,{now:0})
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
 expect(scans).toBe(1)
 await clock.advance(29000)
 await $.tool.call({tool:'mcp__claude-sidecar__sidecar',args:['ask','task']})
 active=true
 await clock.advance(1000)
 expect(scans).toBe(3)
 await clock.advance(3000)
 expect(scans).toBe(4)
 await clock.advance(3000)
 expect(scans).toBe(5)
})
