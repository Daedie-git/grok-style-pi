import { expect, test, mock } from 'claude-code/testing'

const props = {hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:120,scroll:{offset:0,bodyRows:10},view:{}}
const mount = $ => $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'state-test', surface:'terminal', props })
const records = {
  'sc-pane-1.request.json':'{"id":"20261108-215750-ask-sc-pane-1.x","started":1}',
  'sc-pane-1.role':'reviewer\n',
  'sc-pane-1.agent':'pi\n',
  'sc-pane-1.machine':'m1\n/remote checkout\n',
}
function setup(on, override) {
  mock.clock(on, {now:10000})
  on('ui.render', ($, e) => { const {Text} = $.ui.resolve(e); return <Text>below</Text> })
  on('session.start', (_, e) => ({cwd:e.cwd}))
  on('env.get', (_, e) => ({ value:e.name === 'HOME' ? '/fake-home' : e.name === 'HERDR_PANE_ID' ? 'PANE:1' : e.name === 'SIDECAR_AGENT' ? override : undefined }))
  on('fs.list', () => ({value:Object.keys(records).map(name => ({name,kind:'file',size:0,mtimeMs:0,isLink:false}))}))
  on('fs.read', (_, e) => ({value:records[e.path.split('/').at(-1)]}))
}

test('a remote machine binding must not inject its checkout as another display line', async ($, on) => {
  setup(on, undefined)
  await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
  const ui = await mount($)
  try {
    const row = await ui.find({type:'Text',text:/ @ m1/})
    expect(row?.text).not.toContain('\n')
  } finally { await ui.unmount() }
})

test('an empty SIDECAR_AGENT must use the same pane fallback as the launcher', async ($, on) => {
  setup(on, '')
  await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
  const ui = await mount($)
  try { expect((await ui.find({type:'Text',text:/sidecar 1/}))?.text).toMatch(/sidecar 1/) }
  finally { await ui.unmount() }
})

test('a remote request shows its machine label, not the binding id', async ($, on) => {
  records['sc-pane-1.request.json'] = '{"id":"20261108-215750-ask-sc-pane-1.x","started":1,"machine":"lappy"}'
  setup(on, undefined)
  await $.session.start({cwd:'/',surface:'terminal',isInteractive:true})
  const ui = await mount($)
  try { expect((await ui.find({type:'Text',text:/ @ lappy/}))?.text).toMatch(/@ lappy/) }
  finally {
    await ui.unmount()
    records['sc-pane-1.request.json'] = '{"id":"20261108-215750-ask-sc-pane-1.x","started":1}'
  }
})
