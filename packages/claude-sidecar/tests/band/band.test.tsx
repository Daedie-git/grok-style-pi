import { expect, test, mock } from 'claude-code/testing'

const props = {hasSurvey:false,isWorking:false,maxRows:10,bodyColumns:50,scroll:{offset:0,bodyRows:10},view:{}}
const mount = ($, surface='terminal', extra={}) => $.ui.mount({ plugin:'claude-sidecar', component:'AbovePrompt', requestId:'band', surface, props:{...props,...extra} })
const below = (on) => on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>below</Text> })

test('snapshot band, runtime imports, relative module, both supported surfaces, and interval redraw', async ($, on) => {
  on('session.start', (_, e) => ({ cwd:e.cwd }))
  on('env.get', (_, e) => ({ value:e.name === 'HOME' ? '/fake-home' : e.name === 'HERDR_PANE_ID' ? 'PANE:1' : undefined }))
  on('fs.list', () => ({ value:[{ name:'sc-pane-1.request.json', kind:'file', size:0, mtimeMs:0, isLink:false }] }))
  on('fs.read', (_, e) => ({ value:e.path.endsWith('request.json') ? '{"id":"a-b-diff","started":1}' : 'reviewer' }))
  const clock = mock.clock(on, { now:10000 })
  below(on)
  await $.session.start({ cwd:'/', surface:'terminal', isInteractive:true })
  for (const surface of ['terminal','desktop']) {
    const ui = await mount($, surface)
    expect((await ui.find({type:'Text',text:/sidecar/}))?.text).toMatch(/sidecar 1/)
    expect((await ui.find({type:'Text',text:/9s/}))?.text).toMatch(/9s/)
    // AbovePrompt is a replacement site, not an automatically concatenated list.
    expect(await ui.find({type:'Text',text:/below/})).toBe(undefined)
    await ui.unmount()
  }
  const ui = await mount($)
  await clock.advance(3000)
  expect((await ui.find({type:'Text',text:/12s/}))?.text).toMatch(/12s/)
  await ui.unmount()
  const survey = await mount($, 'terminal', {hasSurvey:true})
  expect((await survey.find({type:'Text',text:/below/}))?.text).toBe('below')
  await survey.unmount()
})

test('empty band continues the component chain', async ($, on) => {
  below(on)
  const ui = await mount($)
  expect((await ui.find({type:'Text',text:/below/}))?.text).toBe('below')
  await ui.unmount()
})
