import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const stub = `data:text/javascript,${encodeURIComponent('export const host={},Button=null,Dialog=null,DialogContent=null,DialogHeader=null,DialogTitle=null,DialogDescription=null,Codicon=null,useValue=null,useEffect=null,useState=null,useRef=null,jsx=(tag,props)=>({tag,props}),jsxs=jsx;')}`
const text = (await fs.readFile(new URL('./plugin.js', import.meta.url), 'utf8')).replace(/from '(?:@hermes\/plugin-sdk|react(?:\/jsx-runtime)?)'/g, `from '${stub}'`)
const { quotaView, nextWindow, eligibleQuotaError, confirmedFromAccountUsage, schedulePoint, cutoffJobs, createScheduler, createQuotaObserver, createIO, moveDraftToQueue, cancelHeldJob } = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
const M = 60000, base = Date.UTC(2026,10,25,15,55,42), due = base+2*M
const route = Object.freeze({mode:'local',connectionId:'local',profile:'fixture-profile',targetProfile:'fixture-profile'})
const model = 'gpt-fixture'
const win = (label,used=100,ts=due,scope='account') => ({label,used_percent:used,resets_at:new Date(ts).toISOString(),scope})
const inventory = (windows=[]) => ({provider:'openai-codex',model,providers:[{slug:'openai-codex',usage:{windows}}]})
const payload = { status:'error', error_surface:{ provider:'openai-codex',code:'rate_limit',model,resets_at:due/1000 },persisted_turn:{user_row_id:42} }
const snap = { session_id:'runtime', stored_session_id:'stored', pending:[], running:false, info:{ provider:'openai-codex',model,desktop_protocol:'hermes-gateway-v1' } }
const user = (row_id=42,text='some prompt') => ({ row_id, text, role:'user',row_kind:'message' })
function createHarness(overrides={}) {
  let t=base, state={jobs:[],auto:false,cutoff:0}, tail=Promise.resolve(), alive=true
  const calls=[], notices=[], locked=new Set()
  const locks = { async request(name,{ifAvailable},fn) {
    assert(ifAvailable); if (locked.has(name)) return fn(null)
    locked.add(name); try { return await fn({name}) } finally { locked.delete(name) }
  } }
  const storage = (mutate) => {
    const op = tail.then(() => {
      const pending=structuredClone(state)
      const out=mutate?.(pending)
      if (mutate) state=structuredClone(pending)
      return { state:pending,out }
    })
    tail=op.catch(()=>{})
    return op
  }
  const answers = {
    'session.resume': snap, 'session.create': snap, 'session.info':snap.info,
    'session.transcript':{rows:[user()]}, 'model.options':inventory([win('Session',25,base+3*M),win('Weekly',10,base+100*M)]),
    'prompt.submit': { status:'started', admission_id:'a-fixture' },
    ...overrides,
  }
  const io = { resolve: async x=>x, hold: async ()=>()=>{}, async call(r,m,p) {
    calls.push([r,m,p]); assert(m in answers,m)
    return typeof answers[m]==='function' ? answers[m](r,m,p) : structuredClone(answers[m])
  } }
  const getScheduler=()=>createScheduler({io,locks,storage,now:()=>t,active:()=>alive,notify:(...a)=>notices.push(a)})
  return {getScheduler, storage, calls, notices, io, answers, set now(value){t=value}, get now(){return t}, stop(){alive=false}}
}
const job = extra=>({ id:'j', kind:'timed', due, created:base, route, session:'stored', model, text:'hello', summary:'hello', status:'pending',...extra })
const sendCalls = h=>h.calls.filter(x=>x[1]==='prompt.submit')

test('minute slider returns a local clock minute and limits user delay to 24h',()=>{
  assert.equal(schedulePoint(base,1),Date.UTC(2026,10,25,15,56))
  assert.equal(schedulePoint(base,1440),Date.UTC(2026,10,26,15,55))
  assert.equal(schedulePoint(base,1441),null); assert.equal(schedulePoint(base,0),null); assert.equal(schedulePoint(base,1.5),null)
})
test('quota window targeting uses Session over Weekly and +60s',()=>{
  const q=quotaView(inventory([win('Weekly',80,base+7*24*60*M),win('Session')]))
  assert.equal(nextWindow(q,base),due+M)
  assert.equal(eligibleQuotaError(payload,q,base),due+M)
  assert.equal(nextWindow(quotaView(inventory([win('Weekly')])),base),null)
  assert.equal(nextWindow(q,due),null)
})
test('rate-limit alone, weekly exhaustion, missing time and account pools never schedule',()=>{
  assert.equal(eligibleQuotaError(payload,quotaView(inventory([win('Session',99)])),base),null)
  assert.equal(eligibleQuotaError(payload,quotaView(inventory([win('Session'),win('Weekly',100,base+80*M)])),base),null)
  const pooled=inventory([win('Session')]); pooled.providers[0].usage.accounts=[{windows:[win('Session')]}]
  assert.equal(nextWindow(quotaView(pooled),base),null)
  const q=quotaView(inventory([win('Session')]))
  for(const e of [{code:'billing'},{provider:'openai'},{resets_at:undefined},{resets_at:(due+5*M)/1000}]) {
    assert.equal(eligibleQuotaError({...payload,error_surface:{...payload.error_surface,...e}},q,base),null)
  }
  assert.equal(eligibleQuotaError({...payload,status:'ok'},q,base),null)
  assert.equal(nextWindow(quotaView(inventory([win('Session',100,base+6*60*M)])),base),null)
})
test('fresh native /usage corroborates a stale picker snapshot but not the wrong wall minute',()=>{
  const d=new Date(due), pad=n=>String(n).padStart(2,'0')
  const wall=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const lines=['Provider: openai-codex (Plus)',`Session: 0% remaining (100% used) • resets in 1m (${wall} CST)`,'Weekly: 99% remaining (1% used) • resets later']
  const cached=quotaView(inventory([win('Session',23)]))
  assert.equal(confirmedFromAccountUsage(payload,cached,{lines},base),due+M)
  assert.equal(confirmedFromAccountUsage(payload,cached,{lines:[...lines,'Weekly: 0% remaining (100% used)']},base),null)
  assert.equal(confirmedFromAccountUsage(payload,cached,{lines:lines.map(l=>l.replace(wall,'0000-00-00 00:00'))},base),null)
})
test('route resolution matches complete local route, never a remote name collision',async()=>{
  const remote={ ...route, mode:'remote', connectionId:'cloud' }; const other={...route,profile:'other',targetProfile:'mapped'}
  const api=createIO({ profileRoutes:async()=>[remote,other,route], requestProfile:(...args)=>args })
  assert.deepEqual(await api.owner({profile:'fixture-profile',connectionId:'local'}),route)
  assert.equal(await api.owner({profile:'fixture-profile',connectionId:'cloud'}),undefined)
  assert.equal(await api.resolve({...route,targetProfile:'someone-else'}),undefined)
  assert.deepEqual(api.call(other,'method',{session_id:'stored'}),[other,'method',{session_id:'stored',profile:'mapped'}])
})
test('deadline posts exactly once to pinned original profile and durable session',async()=>{
  const h=createHarness(), a=h.getScheduler(), b=h.getScheduler()
  await a.enqueue(job()); await a.tick(base); assert.equal(sendCalls(h).length,0)
  h.now=due
  const result=await Promise.all([a.tick(),b.tick(),b.dispatch('j',true)])
  assert.equal(result.length,3); assert.equal(sendCalls(h).length,1)
  assert.deepEqual(sendCalls(h)[0],[route,'prompt.submit',{session_id:'runtime',text:'hello',queued:true,submission_id:'chatgpt-window-queue:j'}])
  assert.equal((await b.read()).jobs[0].status,'sent'); assert(!('text' in (await b.read()).jobs[0]))
})
test('fresh draft creates a chat on pinned route, with no foreground-session RPC',async()=>{
  const h=createHarness(), a=h.getScheduler()
  await a.enqueue(job({session:null,cwd:'/example/workspace'})); await a.tick(base)
  h.now=due; await a.tick()
  assert.deepEqual(h.calls.map(x=>[x[1],x[2]]),[
    ['session.create',{source:'gui',provider:'openai-codex',model,cwd:'/example/workspace'}],
    ['prompt.submit',{session_id:'runtime',text:'hello',queued:true,submission_id:'chatgpt-window-queue:j'}],
  ])
  assert.equal((await a.read()).jobs[0].session,'stored')
})
test('restart before due preserves jobs, restart after due only offers manual send',async()=>{
  const h=createHarness(), a=h.getScheduler()
  await a.enqueue(job()); await a.tick(base); h.now=due-1000
  await h.getScheduler().tick(h.now)
  assert.equal((await a.read()).jobs[0].status,'pending')
  h.now=due+1000; const reopened=h.getScheduler(); await reopened.tick(h.now)
  const j=(await reopened.read()).jobs[0]; assert.equal(j.status,'missed'); assert.equal(j.text,'hello'); assert.equal(j.summary,'hello')
  assert.equal(sendCalls(h).length,0); assert.equal(h.notices.length,1); assert.equal(h.notices[0][1],true)
  assert.equal(await reopened.dispatch('j',true),true); assert.equal(sendCalls(h).length,1)
})
test('sleep gap that crossed deadline is manual, not a silent catchup',async()=>{
  const h=createHarness(), a=h.getScheduler(); await a.enqueue(job()); await a.tick(base)
  h.now=due+10*M; await a.tick(); assert.equal(sendCalls(h).length,0); assert.equal((await a.read()).jobs[0].status,'missed')
})
test('busy or changed retry history stays intact',async t=>{
  for (const replies of [{'session.transcript':{rows:[user(),user(43)]}}, {'session.resume':{...snap,running:true}}]) {
    await t.test(JSON.stringify(Object.keys(replies)),async()=>{
      const h=createHarness(replies), a=h.getScheduler(); await a.enable(true); await a.enqueue(job({kind:'retry',userRow:42})); await a.tick(base)
      h.now=due; await a.tick(); assert.equal(sendCalls(h).length,0); assert(['superseded','review'].includes((await a.read()).jobs[0].status))
    })
  }
})
test('archived, protocol mismatch, model switch and yolo do not send',async()=>{
  for(const opts of [{archived:true},{provider:'openai'},{model:'gpt-other'},{yolo:true},{desktop_protocol:'legacy'}]) {
    const h=createHarness({'session.resume':{...snap,info:{...snap.info,...opts}}}), a=h.getScheduler()
    await a.enqueue(job()); await a.tick(base); h.now=due; await a.tick()
    assert.equal(sendCalls(h).length,0); assert.equal((await a.read()).jobs[0].status,'review')
  }
})
test('ambiguous receipt is never auto- or manually replayed from queue',async()=>{
  const h=createHarness({'prompt.submit':()=>{throw Error('socket closed')}}), a=h.getScheduler()
  await a.enqueue(job()); await a.tick(base); h.now=due; await a.tick()
  assert.equal((await a.read()).jobs[0].uncertain,true)
  assert.equal(await a.dispatch('j',true),false); assert.equal(sendCalls(h).length,1)
})
test('restart recovers both pre-submit and uncertain in-flight claims without resend',async()=>{
  const h=createHarness(), a=h.getScheduler()
  await a.enqueue(job({status:'sending',phase:'check'})); await a.enqueue(job({id:'other',status:'sending',phase:'submit'})); await a.tick(base)
  assert.deepEqual((await a.read()).jobs.map(j=>[j.status,j.uncertain]),[['missed',false],['review',true]])
  assert.equal(sendCalls(h).length,0)
})
test('manual setting gates auto scheduling; quota replay and duplicates are deduplicated',async()=>{
  const h=createHarness({'model.options':inventory([win('Session')])}), a=h.getScheduler(), mk=()=>createQuotaObserver({ io:h.io,scheduler:a, now:()=>h.now,lookup:async()=>({route,session:'stored'}),active:()=>true,pause:async()=>{},notify:()=>{} })
  const ev={session_id:'runtime',connectionId:'local',profile:'fixture-profile',payload}
  assert.equal(await mk()(ev),false); await a.enable(true)
  assert.equal(await mk()({...ev,replayed:true}),false)
  assert.equal(await mk()({...ev,profile:'other'}),false)
  await Promise.all([mk()(ev),mk()(ev),mk()(ev)])
  const jobs=(await a.read()).jobs
  assert.equal(jobs.length,1); assert.equal(jobs[0].due,due+M); assert.equal(jobs[0].text,'some prompt'); assert.equal(jobs[0].session,'stored')
  await a.tick(base); h.now=due+M-1000; await a.tick(); h.now=due+M
  await a.tick(); assert.equal(sendCalls(h).length,1)
  assert.equal(sendCalls(h)[0][2].display_kind,'hidden'); assert.notEqual(sendCalls(h)[0][2].text,'some prompt')
})
const completeEvent = {session_id:'runtime',connectionId:'local',profile:'fixture-profile',payload}
const toolRows = n => Array.from({length:16},(_,i)=>({row_id:n+i,role:'tool',row_kind:'message'}))
const observeQuota = (h,scheduler) => createQuotaObserver({io:h.io,scheduler,now:()=>h.now,
  lookup:async()=>({route,session:'stored'}),active:()=>true,pause:async()=>{},notify:()=>{}})
const readCursors = h => h.calls.filter(c=>c[1]==='session.transcript').map(c=>c[2].cursor ?? null)
const quotaHarness = read => createHarness({'session.transcript':read,'model.options':inventory([win('Session')])})

test('429 after multiple tool rounds finds the original user on page three, then auto-continues once',async()=>{
  const h=quotaHarness((r,m,{cursor})=>({session_id:'stored',reset:!cursor,...(!cursor
    ? {rows:toolRows(100),next_cursor:'p2'} : cursor==='p2'
    ? {rows:[{role:'user',row_kind:'compaction'},...toolRows(84)],next_cursor:'p3'}
    : {rows:[user(),...toolRows(60)],next_cursor:'not-needed'})}))
  const a=h.getScheduler(); await a.enable(true); await a.tick(base)
  const observe=observeQuota(h,a)
  assert.deepEqual(await Promise.all([observe(completeEvent),observe(completeEvent)]),[true,false])
  assert.deepEqual(readCursors(h),[null,'p2','p3',null])
  assert.deepEqual((await a.read()).jobs.map(j=>[j.kind,j.status,j.userRow,j.due]),[['retry','pending',42,due+M]])
  h.answers['model.options']=inventory([win('Session',0,due+5*60*M)])
  h.now=due+M-3000; await a.tick(); assert.equal(sendCalls(h).length,0)
  h.now=due+M; await a.tick(); await a.tick()
  assert.deepEqual(readCursors(h),[null,'p2','p3',null,null,'p2','p3',null])
  assert.equal(sendCalls(h).length,1)
  assert.deepEqual(sendCalls(h)[0][0],route); assert.equal(sendCalls(h)[0][2].session_id,'runtime')
  assert.equal(sendCalls(h)[0][2].display_kind,'hidden'); assert.equal((await a.read()).jobs[0].status,'sent')
})

test('a newer user message, even hidden, is not skipped to reach the old request',async()=>{
  const h=quotaHarness((r,m,{cursor})=>cursor?{rows:[user()],next_cursor:null}
    :{rows:toolRows(100),next_cursor:'p2'})
  const a=h.getScheduler(); await a.enable(true); await a.tick(base)
  const observe=observeQuota(h,a); assert.equal(await observe(completeEvent),true)
  h.answers['session.transcript']=(r,m,{cursor})=>cursor==='p2'
    ?{rows:[...toolRows(84),{...user(43),display_kind:'hidden'}],next_cursor:'p3'}
    :cursor==='p3'?{rows:[user()],next_cursor:null}:{rows:toolRows(100),next_cursor:'p2'}
  assert.equal(await observe(completeEvent),false)
  h.answers['model.options']=inventory([win('Session',0,due+5*60*M)])
  h.now=due+M-3000; await a.tick(); h.now=due+M; await a.tick()
  assert.equal(sendCalls(h).length,0); assert.equal((await a.read()).jobs[0].status,'superseded')
  assert(!readCursors(h).includes('p3'))
})

test('partial, stale or inconsistent transcript reads fail closed',async t=>{
  for(const [name,read,count] of [
    ['unchanged cursor',(r,m,{cursor})=>({rows:toolRows(60),next_cursor:'p2'}),2],
    ['cursor reset',(r,m,{cursor})=>({rows:[user()],reset:true,next_cursor:null,...(!cursor?{rows:toolRows(60),next_cursor:'p2'}:{})}),2],
    ['episode mismatch',(r,m,{cursor})=>({rows:[user()],session_id:'somewhere-else'}),1],
    ['page budget',(r,m,{cursor})=>({rows:toolRows(60),next_cursor:String(Number(cursor ?? 0)+1)}),8],
    ['changed head',(()=>{let heads=0;return (r,m,{cursor})=>cursor?{rows:[user()],next_cursor:null}
      :{rows:heads++%2===0?toolRows(100):[user(43)],next_cursor:'p2'}})(),3],
  ]) await t.test(name,async()=>{
    const h=quotaHarness(read), a=h.getScheduler(); await a.enable(true); await a.tick(base)
    await assert.rejects(observeQuota(h,a)(completeEvent),/完整核对/)
    assert.equal((await a.read()).jobs.length,0)
    assert.equal(readCursors(h).length,count)
    await a.enqueue(job({kind:'retry',userRow:42})); h.answers['model.options']=inventory([win('Session',0,due+5*60*M)])
    h.now=due-3000; await a.tick(); h.now=due; await a.tick()
    assert.equal(sendCalls(h).length,0); assert.equal((await a.read()).jobs[0].status,'review')
  })
})
test('disabled auto retry becomes manual-reviewable; cancel erases full local copy',async()=>{
  const h=createHarness(), a=h.getScheduler(); await a.enable(true); await a.enqueue(job({kind:'retry'})); await a.enable(false)
  assert.equal((await a.read()).jobs[0].status,'missed'); await a.cancel('j'); const j=(await a.read()).jobs[0]
  assert.equal(j.status,'canceled'); assert(!('text' in j)); assert.equal(sendCalls(h).length,0)
})
test('startup cutoff is scoped to pending jobs strictly before opening',()=>{
  const result=cutoffJobs([job({due:base-1}),job({due:base}),job({due:base-1,status:'sent'})],base)
  assert.deepEqual(result.map(j=>j.status),['missed','pending','sent'])
})

function textDraft(initial={text:'queued body',hasAttachments:false}) {
  let value=initial
  return { read:()=>value, change:v=>{value=v}, replace:(expected,text)=> {
    if (value!==expected || value.hasAttachments) return false
    value={text,hasAttachments:false}; return true
  } }
}
const target={route,stored:'stored',model}
const capture = (h,scheduler,composer,id='text') => moveDraftToQueue({composer,scheduler,target,due,mode:'timed',match:()=>true,now:()=>h.now,id})
test('captures text durably before clearing and sends only to the original route',async()=>{
  const h=createHarness(), a=h.getScheduler(), composer=textDraft()
  await capture(h,a,composer)
  assert.deepEqual(composer.read(),{text:'',hasAttachments:false})
  assert.equal((await a.read()).jobs[0].draft,undefined)
  h.now=due; await a.tick()
  assert.equal(sendCalls(h)[0][2].text,'queued body')
  assert.equal(sendCalls(h)[0][2].attachments,undefined)
})
test('existing or late attachments require modal outcome and leave both input and queue unchanged',async()=>{
  const h=createHarness(), a=h.getScheduler(), attached={text:'draft with attachment',hasAttachments:true}, composer=textDraft(attached)
  assert.equal(await capture(h,a,composer),null)
  assert.equal(composer.read(),attached)
  const delayed=textDraft()
  const original=delayed.replace
  delayed.replace=(expected,text)=>{delayed.change(attached);return original(expected,text)}
  assert.equal(await capture(h,a,delayed),null)
  assert.equal(delayed.read(),attached)
  assert.equal((await a.read()).jobs.length,0)
})
test('a hold suppresses dispatch, and restore returns text only to an empty editor',async()=>{
  const h=createHarness(), a=h.getScheduler(), composer=textDraft({text:'',hasAttachments:false})
  await a.enqueue(job({text:'queued body'}))
  const held=await a.holdJob('j'); h.now=due
  assert.equal(await a.dispatch('j'),false)
  assert(await cancelHeldJob({scheduler:a,composer,job:held,choice:'restore'}))
  assert.deepEqual(composer.read(),{text:'queued body',hasAttachments:false})
  assert.equal((await a.read()).jobs[0].status,'restored')
})
test('cancel never overwrites attachments or a changed draft; log failure retains hold',async()=>{
  const h=createHarness(), a=h.getScheduler(), composer=textDraft()
  await a.enqueue(job()); const held=await a.holdJob('j'), expected=composer.read()
  const later={text:'later unsaved work',hasAttachments:true}; composer.change(later)
  assert.equal(await cancelHeldJob({scheduler:a,composer,job:held,choice:'override',expected}),false)
  assert.equal(await cancelHeldJob({scheduler:a,composer,job:held,choice:'override',expected:later}),false)
  await assert.rejects(cancelHeldJob({scheduler:a,composer,job:held,choice:'log',log:async()=>{throw new Error('disk full')}}),/disk full/)
  assert.equal((await a.read()).jobs[0].status,'held')
  assert.equal(composer.read(),later)
})
test('legacy attachment jobs are preserved for review and never submitted text-only',async()=>{
  const h=createHarness(), a=h.getScheduler(), draft={text:'keep',attachments:[{kind:'file'}]}
  await a.enqueue(job({draft})); h.now=due; await a.tick()
  assert.equal(sendCalls(h).length,0)
  const entry=(await a.read()).jobs[0]
  assert.equal(entry.status,'review'); assert.deepEqual(entry.draft,draft)
  assert.match(entry.note,/不会改用纯文字发送/)
})
test('restart during draft capture or cancellation never silently replays or offers resend',async()=>{
  const h=createHarness(), a=h.getScheduler()
  await a.enqueue(job({status:'capturing'})); await a.enqueue(job({id:'canceling',status:'held',previousStatus:'pending'}))
  h.now=due; await a.tick(due)
  assert.deepEqual((await a.read()).jobs.map(j=>[j.status,j.uncertain]),[['review',true],['review',true]])
  assert.equal(await a.dispatch('canceling',true),false)
  assert.equal(sendCalls(h).length,0)
})
