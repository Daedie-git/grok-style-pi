// From the sidecar review of 0.20.0: each test reproduced a lost or duplicate delivery.
import { expect, test, mock } from 'claude-code/testing'
const TOOL='mcp__claude-sidecar__sidecar', DIR='/fake/.cache/claude-sidecar/jobs/sc-pane-1'
function latch() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r}); return {promise,resolve} }
function setup(on) {
 const files:Record<string,string>={}, submitted:string[]=[]
 let readHook:(e:any)=>Promise<void>=async()=>{}, writeHook:(e:any)=>Promise<void>=async()=>{}, dropPrompt=false
 on('session.start',(_,e)=>({cwd:e.cwd}))
 on('env.get',(_,e)=>({value:e.name==='HOME'?'/fake':e.name==='HERDR_PANE_ID'?'PANE:1':undefined}))
 on('tool.register',(_,e)=>({value:{tool:`mcp__claude-sidecar__${e.name}`}}))
 on('fs.list',(_,e)=>({value:Object.keys(files).filter(p=>p.startsWith(`${e.path}/`)).map(p=>({name:p.slice(e.path.length+1),kind:'file',size:0,mtimeMs:0,isLink:false}))}))
 on('fs.read',async(_,e)=>{await readHook(e);return e.path in files?{value:files[e.path]}:{deny:'missing'}})
 on('fs.write',async(_,e)=>{await writeHook(e);files[e.path]=e.text;return {value:undefined}})
 on('process.run',(_,e)=>{if(e.argv[2]?.startsWith('rm '))delete files[e.argv[4]];return {value:{exitCode:0,stdout:'',stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}})
 on('prompt.submit',(_,e)=>{if(dropPrompt)return {drop:'host limit reached'};submitted.push(e.text);return {text:e.text}})
 on('turn.start',(_,e)=>({turnId:e.turnId}))
 on('turn.complete',(_,e)=>({text:e.answer}))
 on('tool.call',()=>({result:'ran'}))
 const clock=mock.clock(on,{now:Date.UTC(2026,10,12,9,0,0)})
 const ids=()=>Object.keys(files).filter(p=>p.endsWith('.json')).map(p=>p.slice(DIR.length+1,-5))
 const finish=(id:string)=>{files[`${DIR}/${id}.out`]='UNIQUE REPORT';files[`${DIR}/${id}.done`]='{"code":0,"finished":1}'}
 return {files,submitted,clock,ids,finish,read:(fn)=>{readHook=fn},write:(fn)=>{writeHook=fn},drop:(value:boolean)=>{dropPrompt=value}}
}
test('parallel tool results must claim held job once',async($,on)=>{
 const s=setup(on)
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true});await $.turn.start({text:'go',turnId:'t1'})
 await $.tool.call({tool:TOOL,args:['ask','one']});s.finish(s.ids()[0]);await s.clock.advance(3000)
 const entered=latch(),release=latch();let markers=0
 s.write(async e=>{if(e.path.endsWith('.delivered')) {markers++;entered.resolve();await release.promise}})
 const a=$.tool.call({tool:'Read',file_path:'a'});await entered.promise
 const b=$.tool.call({tool:'Read',file_path:'b'});await Promise.resolve();await Promise.resolve();release.resolve()
 const results=await Promise.all([a,b]);const n=results.filter(r=>r.context?.some(t=>t.includes('UNIQUE REPORT'))).length
 expect(n).toBe(1)
})
test('starting a job during a completed-job scan must retain polling',async($,on)=>{
 const s=setup(on)
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true});await $.turn.start({text:'go',turnId:'t1'})
 await $.tool.call({tool:TOOL,args:['ask','one']});const first=s.ids()[0];s.finish(first)
 const entered=latch(),release=latch();s.read(async e=>{if(e.path===`${DIR}/${first}.out`){entered.resolve();await release.promise}})
 const advancing=s.clock.advance(3000);await entered.promise
 await $.tool.call({tool:TOOL,args:['--slot','2','ask','two']});const second=s.ids().find(id=>id!==first)!
 release.resolve();await advancing;s.finish(second)
 await s.clock.advance(12000)
 const result=await $.tool.call({tool:'Read',file_path:'b'})
 expect(result.context?.some(t=>t.includes(second))).toBe(true)
})
test('a dropped prompt must remain pending for later delivery',async($,on)=>{
 const s=setup(on)
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:TOOL,args:['ask','one']});const id=s.ids()[0];s.finish(id)
 s.drop(true);await s.clock.advance(3000)
 expect(`${DIR}/${id}.delivered` in s.files).toBe(false)
 s.drop(false)
 // Re-run session start to simulate a reload's scan of exactly the persisted files.
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true});await s.clock.advance(6000)
 expect(s.submitted.length).toBe(1)
})
