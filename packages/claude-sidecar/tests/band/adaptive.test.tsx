import { expect, test, mock } from 'claude-code/testing'
const props = {hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:120,scroll:{offset:0,bodyRows:10},view:{}}
const mount = $ => $.ui.mount({plugin:'claude-sidecar',component:'AbovePrompt',requestId:'adaptive',surface:'terminal',props})
function setup(on, active=false) {
  let scans=0
  on('session.start', (_,e) => ({cwd:e.cwd}))
  on('env.get',(_,e)=>({value:e.name==='HOME'?'/fake-home':e.name==='HERDR_PANE_ID'?'PANE:1':undefined}))
  on('fs.list',(_,e)=>{if(!e.path.includes('/jobs/'))scans++;return {value:active?(active==='pending'?['sc-pane-1.request.json','sc-pane-1.pending']:['sc-pane-1.request.json']).map(name=>({name,kind:'file',size:0,mtimeMs:0,isLink:false})):[]}})
  on('fs.read',(_,e)=>({value:e.path.endsWith('.pending')?'{"id":"a-b-ask"}':e.path.endsWith('request.json')?(active==='pending'?'{"id":"a-b-ask","started":1,"finished":2}':'{"id":"a-b-ask","started":1}'):e.path.endsWith('.machine')?'local':'reviewer'}))
  on('ui.render',($,e)=>{const {Text}=$.ui.resolve(e);return <Text>below</Text>})
  on('tool.call',()=>({result:{}}))
  const clock=mock.clock(on,{now:10000})
  return {clock,get scans(){return scans},active(value){active=value}}
}
test('idle scans every 30s, launcher calls discover work after 1s, seconds tick without scanning',async($,on)=>{
 const s=setup(on)
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
 expect(s.scans).toBe(1)
 await s.clock.advance(29000)
 expect(s.scans).toBe(1)
 await s.clock.advance(1000)
 expect(s.scans).toBe(2)
 await $.tool.call({tool:'mcp__claude-sidecar__sidecar',args:['ask','task']})
 s.active(true)
 await s.clock.advance(1000)
 expect(s.scans).toBe(3)
 const ui=await mount($)
 expect((await ui.find({type:'Text',text:/40s/}))?.text).toMatch(/40s/)
 await s.clock.advance(1000)
 expect(s.scans).toBe(3)
 expect((await ui.find({type:'Text',text:/41s/}))?.text).toMatch(/41s/)
 await s.clock.advance(2000)
 expect(s.scans).toBe(4)
 await ui.unmount()
})
test('a question arriving while idle is picked up at the next 30s scan',async($,on)=>{
 const s=setup(on)
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
 s.active('pending')
 await s.clock.advance(30000)
 const ui=await mount($)
 expect((await ui.find({type:'Text',text:/needs an answer/}))?.text).toMatch(/needs an answer/)
 await ui.unmount()
})
