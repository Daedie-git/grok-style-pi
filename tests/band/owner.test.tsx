import { expect, test } from 'claude-code/testing'

test('a Herdr app terminal owns the slots named after it', async ($, on) => {
  on('session.start', (_, e) => ({ cwd:e.cwd }))
  on('env.get', (_, e) => ({ value:e.name === 'HOME' ? '/fake-home' : e.name === 'HC_TERMINAL_ID' ? 't7' : undefined }))
  on('fs.list', () => ({ value:[{ name:'sc-hc-t7-2.request.json', kind:'file', size:0, mtimeMs:0, isLink:false }] }))
  on('fs.read', (_, e) => ({ value:e.path.endsWith('request.json') ? '{"id":"a-b-diff","started":1}' : 'reviewer' }))
  await $.session.start({ cwd:'/', surface:'terminal', isInteractive:true })
  const ui = await $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'band', surface:'terminal',
    props:{hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:50,scroll:{offset:0,bodyRows:10},view:{}} })
  expect((await ui.find({type:'Text',text:/sidecar/}))?.text).toMatch(/sidecar 2/)
  await ui.unmount()
})

test('a stopped slot with an unanswered question leaves the band', async ($, on) => {
  on('session.start', (_, e) => ({ cwd:e.cwd }))
  on('env.get', (_, e) => ({ value:e.name === 'HOME' ? '/fake-home' : e.name === 'HERDR_PANE_ID' ? 'PANE:1' : undefined }))
  on('fs.list', () => ({ value:['sc-pane-1-31.request.json','sc-pane-1-31.pending','sc-pane-1-31.stopped',
    'sc-pane-1-32.request.json','sc-pane-1-32.pending'].map(name => ({ name, kind:'file', size:0, mtimeMs:0, isLink:false })) }))
  on('fs.read', (_, e) => ({ value:e.path.endsWith('request.json') ? '{"id":"a-b-ask","started":1,"finished":2}' : 'reviewer' }))
  await $.session.start({ cwd:'/', surface:'terminal', isInteractive:true })
  const ui = await $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'band', surface:'terminal',
    props:{hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:50,scroll:{offset:0,bodyRows:10},view:{}} })
  expect((await ui.find({type:'Text',text:/sidecar 32/}))?.text).toMatch(/needs an answer/)
  expect(await ui.find({type:'Text',text:/sidecar 31/})).toBe(undefined)
  await ui.unmount()
})

test('SIDECAR_MUX=hc shows the hc slots although a herdr pane ID is inherited', async ($, on) => {
  on('session.start', (_, e) => ({ cwd:e.cwd }))
  const env = { HOME:'/fake-home', HERDR_PANE_ID:'PANE:1', HC_TERMINAL_ID:'t1', SIDECAR_MUX:'hc' }
  on('env.get', (_, e) => ({ value:env[e.name] }))
  on('fs.list', () => ({ value:['sc-hc-t1-2.request.json','sc-pane-1-9.request.json'].map(name => ({ name, kind:'file', size:0, mtimeMs:0, isLink:false })) }))
  on('fs.read', (_, e) => ({ value:e.path.endsWith('request.json') ? '{"id":"a-b-diff","started":1}' : 'reviewer' }))
  await $.session.start({ cwd:'/', surface:'terminal', isInteractive:true })
  const ui = await $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'band', surface:'terminal',
    props:{hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:50,scroll:{offset:0,bodyRows:10},view:{}} })
  expect((await ui.find({type:'Text',text:/sidecar 2/}))?.text).toMatch(/sidecar 2/)
  expect(await ui.find({type:'Text',text:/sidecar 9/})).toBe(undefined)
  await ui.unmount()
})
