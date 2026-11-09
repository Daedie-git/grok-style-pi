import { expect, test, mock } from 'claude-code/testing'

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
  on('fs.read', (_, e) => ({ value:e.path.endsWith('.pending') ? '{"id":"a-b-ask"}' : e.path.endsWith('request.json') ? '{"id":"a-b-ask","started":1,"finished":2}' : 'reviewer' }))
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

test('on Windows without HOME the band reads the user profile', async ($, on) => {
  on('session.start', (_, e) => ({ cwd:e.cwd }))
  const env = { USERPROFILE:'C:\\Users\\Bjorn', HC_TERMINAL_ID:'t6' }
  on('env.get', (_, e) => ({ value:env[e.name] }))
  // The harness runs on Linux, where a Windows profile path is resolved against the working directory.
  on('fs.list', (_, e) => ({ value:e.path.endsWith('C:\\Users\\Bjorn/.cache/claude-sidecar')
    ? ['sc-hc-t6-11.request.json'].map(name => ({ name, kind:'file', size:0, mtimeMs:0, isLink:false })) : [] }))
  on('fs.read', (_, e) => ({ value:e.path.endsWith('request.json') ? '{"id":"a-b-ask","started":1}' : 'implementer' }))
  mock.clock(on, { now:10000 })
  await $.session.start({ cwd:'/', surface:'terminal', isInteractive:true })
  const ui = await $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'band', surface:'terminal',
    props:{hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:50,scroll:{offset:0,bodyRows:10},view:{}} })
  expect((await ui.find({type:'Text',text:/sidecar 11/}))?.text).toMatch(/implementer/)
  await ui.unmount()
})

test('a question whose answer reached the sidecar leaves the band; an undelivered answer keeps it', async ($, on) => {
  on('session.start', (_, e) => ({ cwd:e.cwd }))
  on('env.get', (_, e) => ({ value:e.name === 'HOME' ? '/fake-home' : e.name === 'HERDR_PANE_ID' ? 'PANE:1' : undefined }))
  on('fs.list', () => ({ value:['31','32','33'].flatMap(n => [`sc-pane-1-${n}.request.json`, `sc-pane-1-${n}.pending`])
    .map(name => ({ name, kind:'file', size:0, mtimeMs:0, isLink:false })) }))
  on('fs.read', (_, e) => ({ value:
    // 31: the answer was delivered, then ended without a report.
    e.path.endsWith('-31.pending') ? '{"id":"a-b-ask","answered":"a-c-answer"}' : e.path.endsWith('-31.request.json') ? '{"id":"a-c-answer","started":1,"finished":2,"exit_code":2}' :
    // 32: the answer was refused before delivery (blocked pane), so the question is still open.
    e.path.endsWith('-32.pending') ? '{"id":"a-d-ask"}' : e.path.endsWith('-32.request.json') ? '{"id":"a-e-answer","started":1,"finished":2,"exit_code":1}' :
    // 33: an older launcher's bare id.
    e.path.endsWith('-33.pending') ? 'a-f-ask' : e.path.endsWith('-33.request.json') ? '{"id":"a-f-ask","started":1,"finished":2,"exit_code":3}' : 'reviewer' }))
  await $.session.start({ cwd:'/', surface:'terminal', isInteractive:true })
  const ui = await $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'band', surface:'terminal',
    props:{hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:50,scroll:{offset:0,bodyRows:10},view:{}} })
  expect(await ui.find({type:'Text',text:/sidecar 31/})).toBe(undefined)
  expect((await ui.find({type:'Text',text:/sidecar 32/}))?.text).toMatch(/needs an answer/)
  expect((await ui.find({type:'Text',text:/sidecar 33/}))?.text).toMatch(/needs an answer/)
  await ui.unmount()
})
