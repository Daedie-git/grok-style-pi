import {expect,test,mock} from 'claude-code/testing'

test('a remote machine named local must still have a remote indicator',async($,on)=>{
 const records={
  'sc-pane-1.request.json':'{"id":"20261108-225447-ask-sc-pane-1.x","started":1,"machine":"local"}',
  'sc-pane-1.machine':'m1\n/remote checkout\n',
  'sc-pane-1.role':'reviewer',
  'sc-pane-1.agent':'pi',
 }
 on('session.start',(_,e)=>({cwd:e.cwd}))
 on('env.get',(_,e)=>({value:e.name==='HOME'?'/fake-home':e.name==='HERDR_PANE_ID'?'PANE:1':undefined}))
 on('fs.list',()=>({value:Object.keys(records).map(name=>({name,kind:'file',size:0,mtimeMs:0,isLink:false}))}))
 on('fs.read',(_,e)=>({value:records[e.path.split('/').at(-1)]}))
 on('ui.render',($,e)=>{const {Text}=$.ui.resolve(e);return <Text>below</Text>})
 mock.clock(on,{now:10000})
 await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount({plugin:'claude-sidecar',component:'AbovePrompt',requestId:'edge',surface:'terminal',props:{hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:120,scroll:{offset:0,bodyRows:10},view:{}}})
 try {expect((await ui.find({type:'Text',text:/sidecar 1/}))?.text).toMatch(/ @ /)}
 finally {await ui.unmount()}
})
