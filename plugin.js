import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const { host, Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Popover, PopoverTrigger, PopoverContent, useComposerSession, Codicon, useValue } = sdk

const ID = 'chatgpt-window-queue'
const EDITION = '纯文字版 · v3.0.0'
const PROVIDER = 'openai-codex'
const MIN = 60000
const MAX_TEXT = 24000
const MAX_JOBS = 120
const RETRY_TEXT = '请接着完成上一次因 ChatGPT 额度中断而未完成的请求。以当前对话和已经完成的工作为准；先核对现状，不要重复已经执行的命令、写入或其他外部操作。'
const PENDING = new Set(['pending', 'missed', 'review', 'sending', 'capturing', 'held'])
const LABEL = { pending: '等待发送', missed: '错过时间', review: '待人工核对', sending: '正在交给 Hermes', sent: 'Hermes 已接收', canceled: '已取消', superseded: '原对话已有后续消息', capturing: '正在保存草稿', held: '待处理取消', restored: '已退回输入框' }
const fmt = (ms) => Number.isFinite(ms) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms) : '未知'
const day = (ms) => new Date(ms).toDateString()
const displayTime = (ms, now) => !Number.isFinite(ms) ? '未知' : `${ms >= now && day(ms) !== day(now) ? '次日或之后 ' : ''}${fmt(ms)}`
const summary = text => text.trim().replace(/\s+/g, ' ').slice(0, 100)
const relative = m => m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`
const sameRoute = (a, b) => a && b && a.mode === 'local' && b.mode === 'local' && ['connectionId', 'profile', 'targetProfile'].every(k => a[k] === b[k])
const parseInstant = x => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(x) ? Date.parse(x) : NaN
const isSessionWindow = label => /^(session|5\s*(?:h|hours?|小时))$/i.test(String(label ?? '').trim())
const asWindows = values => (Array.isArray(values) ? values : []).filter(w => typeof w?.used_percent === 'number' && Number.isFinite(w.used_percent) && w.used_percent >= 0).map(w => ({ label: String(w.label || ''), used: w.used_percent, reset: parseInstant(w.resets_at), account: (w.scope ?? 'account') === 'account' }))

export function quotaView(inventory) {
  const r = (Array.isArray(inventory?.providers) ? inventory.providers : []).find(p => p.slug === PROVIDER && !p.is_user_defined)
  if (!r || r.authenticated === false) return { windows: [], accounts: [], five: null, blocked: false, seen: false }
  const accounts = Array.isArray(r.usage?.accounts) ? r.usage.accounts.map((a, n) => ({ label: `账号 ${n + 1}`, windows: asWindows(a.windows) })) : []
  const windows = asWindows(r.usage?.windows)
  const short = windows.filter(w => w.account && isSessionWindow(w.label))
  const accountReset = r.limit?.scope === 'account' ? parseInstant(r.limit.resets_at) : NaN
  return { accounts, windows, five: accounts.length === 0 && short.length === 1 ? short[0] : null, accountReset, seen: true }
}

export function nextWindow(q, now) {
  const reset = q?.five?.reset
  return Number.isFinite(reset) && reset > now && reset <= now + 5 * 60 * MIN + MIN ? reset + MIN : null
}

export function eligibleQuotaError(payload, q, now) {
  const s = payload?.error_surface
  if (!s || s.provider !== PROVIDER || s.code !== 'rate_limit' || payload.status !== 'error' || payload.paused) return null
  const epoch = typeof s.resets_at === 'number' ? s.resets_at * 1000 : NaN
  const due = nextWindow(q, now)
  if (due === null || q.five.used < 100 || !Number.isFinite(epoch) || Math.abs(epoch - q.five.reset) > 2 * MIN) return null
  if (q.windows.some(w => w !== q.five && w.account && w.used >= 100 && (!Number.isFinite(w.reset) || w.reset > now))) return null
  if (Number.isFinite(q.accountReset) && q.accountReset > q.five.reset + 2 * MIN) return null
  return due
}

// The picker intentionally uses a 120 s cache. The local owner's /usage RPC does a
// fresh read for this session. Use its exact, version-pinned labels to corroborate the
// absolute reset carried by the error; never derive an epoch from a localized phrase.
export function confirmedFromAccountUsage(payload, inv, read, now) {
  const s = payload?.error_surface, lines = read?.lines
  const epoch = typeof s?.resets_at === 'number' ? s.resets_at * 1000 : NaN
  if (s?.provider !== PROVIDER || s.code !== 'rate_limit' || payload.status !== 'error' || payload.paused ||
    !inv?.seen || inv.accounts.length || !Number.isFinite(epoch) || epoch <= now || epoch > now + 301 * MIN || !Array.isArray(lines)) return null
  if (!lines.some(l => /^Provider: openai-codex(?: \([^)]+\))?$/.test(l)) ||
    lines.some(l => /^Weekly: (?:0% remaining|unavailable)/.test(l))) return null
  const parts = new Date(epoch)
  const pad = n => String(n).padStart(2, '0')
  const wall = `${parts.getFullYear()}-${pad(parts.getMonth() + 1)}-${pad(parts.getDate())} ${pad(parts.getHours())}:${pad(parts.getMinutes())}`
  const a = lines.filter(l => /^Session: 0% remaining \(100% used\) • resets in /.test(l))
  if (a.length !== 1 || !a[0].includes(`(${wall} `)) return null
  if (Number.isFinite(inv.accountReset) && inv.accountReset > epoch + 2 * MIN) return null
  return epoch + MIN
}

export function schedulePoint(base, delay) {
  if (!Number.isInteger(delay) || delay < 1 || delay > 1440) return null
  return Math.floor(base / MIN) * MIN + delay * MIN
}

export function cutoffJobs(jobs, cutoff) {
  return jobs.map(j => j.status === 'pending' && j.due < cutoff ? { ...j, status: 'missed', note: '到点时队列未在运行。' } : j)
}

const initState = () => ({ jobs: [], auto: true, autoVersion: 2, cutoff: 0 })
const softError = message => Object.assign(new Error(message), { safe: true })
const dateNow = () => Date.now()
const readIDB = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(`${ID}-v1`, 1)
  req.onupgradeneeded = () => req.result.createObjectStore('state')
  req.onerror = () => reject(req.error)
  req.onblocked = () => reject(new Error('queue storage blocked'))
  req.onsuccess = () => resolve(req.result)
})

// Mutations resolve only after Chromium acknowledges the strict IDB transaction.
export function createStore(dbPromise) {
  return async (mutate = null) => {
    const db = await dbPromise
    return new Promise((resolve, reject) => {
      const tx = mutate ? db.transaction('state', 'readwrite', { durability: 'strict' }) : db.transaction('state', 'readonly')
      const table = tx.objectStore('state')
      let state, out, cause
      tx.oncomplete = () => resolve({ state, out })
      tx.onabort = () => reject(cause || tx.error || new Error('queue transaction aborted'))
      const get = table.get('queue')
      get.onsuccess = () => {
        try {
          state = get.result ?? initState()
          if (!Array.isArray(state.jobs) || typeof state.auto !== 'boolean') throw new Error('queue schema invalid')
          if (mutate) { out = mutate(state); table.put(state, 'queue') }
        } catch (err) { cause = err; tx.abort() }
      }
    })
  }
}

function addJob(state, job) {
  if (state.jobs.some(j => j.id === job.id)) return false
  while (state.jobs.length >= MAX_JOBS) {
    const index = state.jobs.findIndex(j => !PENDING.has(j.status))
    if (index < 0) throw softError('队列已满，请先处理或取消旧任务。')
    state.jobs.splice(index, 1)
  }
  state.jobs.push(job)
  return true
}

const withoutBody = ({ text, draft, ...rest }) => rest
const rowText = row => typeof row?.text === 'string' && !row.truncated ? row.text : null
const latestUser = snapshot => snapshot?.rows?.filter(r => r.role === 'user' && r.row_kind === 'message').at(-1)
const validText = text => typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT
const idOf = row => Number.isSafeInteger(row?.row_id) && row.row_id > 0 ? row.row_id : null
const profileMatch = (tag, route) => !tag || tag === route.profile || tag === route.targetProfile
const expectedModel = (info, job) => info?.provider === PROVIDER && info?.model === job.model
const canonical = snap => snap?.info?.desktop_protocol === 'hermes-gateway-v1'
const accepted = res => Boolean(res?.admission_id) && ['queued', 'started', 'terminal'].includes(res.status)
const wakeDelay = 5000

export function createScheduler({ io, storage, locks, now = dateNow, notify = () => {}, change = () => {}, active = () => true }) {
  let lastTick = null, busy = false, wakeCutoff = null
  const read = async () => (await storage()).state
  async function edit(fn) { const result = await storage(fn); change(); return result.out }
  const modify = (id, fn) => edit(s => {
    const index = s.jobs.findIndex(j => j.id === id)
    if (index < 0) return null
    const output = fn(s.jobs[index], s)
    if (output) s.jobs[index] = output
    return output
  })
  const stop = async (id, status, note) => modify(id, j => j.status === 'sending' ? { ...j, status, note } : null)
  async function dispatch(id, manual = false) {
    return locks.request(`${ID}:send:${id}`, { ifAvailable: true }, async lock => {
      if (!lock || !active()) return false
      const job = await modify(id, (j, state) => {
        if (!active() || !(manual ? ['pending', 'missed', 'review'].includes(j.status) && !j.uncertain : j.status === 'pending' && j.due <= now())) return null
        if (!manual && j.kind === 'retry' && !state.auto) return null
        return { ...j, status: 'sending', started: now(), phase: 'check', note: null }
      })
      if (!job) return false
      let submitted = false, release = () => {}
      const settle = async (status, note, extra = {}) => modify(id, j => {
        if (j.status !== 'sending') return null
        const shape = status === 'sent' ? withoutBody(j) : j
        return { ...shape, ...extra, status, note }
      })
      try {
        if (job.draft) throw softError('此任务来自旧版附件队列，不会改用纯文字发送。请人工核对或取消。')
        const route = await io.resolve(job.route)
        if (!route) throw softError('原本地 profile 已不存在或归属无法确认。')
        release = await io.hold(route, manual)
        let snap
        if (job.session) {
          snap = await io.call(route, 'session.resume', { session_id: job.session, source: 'gui', omit_messages: true })
          if (snap.stored_session_id !== job.session) throw softError('会话已改名、迁移、归档或无法确认；未发送。')
        } else {
          // A fresh draft has no persisted session. Only create its own conversation, never send to a foreground draft.
          snap = await io.call(route, 'session.create', { source: 'gui', provider: PROVIDER, model: job.model, ...(job.cwd ? { cwd: job.cwd } : {}) })
        }
        if (!active()) throw softError('插件已关闭；未提交消息。')
        if (!expectedModel(snap.info, job) || snap.info.archived === true || snap.info.yolo === true) {
          throw softError('原会话的模型/服务商已改变、会话已归档或开启了跳过审批；未发送。')
        }
        const sid = snap.session_id
        const stored = snap.stored_session_id
        if (!sid || !stored || !canonical(snap)) throw softError('当前后端未提供安全的桌面会话投递协议。')
        if (job.kind !== 'timed' && !manual) {
          const q = quotaView(await io.call(route, 'model.options', { session_id: sid }))
          const blocked = !q.seen || q.accounts.length > 0 || q.windows.some(w => w.account && w.used >= 100 && (!Number.isFinite(w.reset) || w.reset > now())) || (Number.isFinite(q.accountReset) && q.accountReset > now())
          if (blocked) throw softError('Hermes 仍报告账号受限或账号归属不明确；未自动发送。')
        }
        if (job.kind === 'retry') {
          const trail = await io.call(route, 'session.transcript', { session_id: stored, order: 'latest', limit: 16 })
          if (idOf(latestUser(trail)) !== job.userRow) {
            await settle('superseded', '额度中断后又有用户消息，或原消息已不在可核对的历史中。')
            return false
          }
          if (snap.running === true || snap.pending?.length) {
            throw softError('原会话正在处理别的回合；未自动续跑。')
          }
        }
        if (!active()) throw softError('插件已关闭；未提交消息。')
        const prepared = job.kind === 'retry' ? { text: RETRY_TEXT, display_kind: 'hidden' } : { text: job.text }
        const ready = await modify(id, j => j.status === 'sending' ? { ...j, session: stored, phase: 'submit' } : null)
        if (!ready || !active()) throw softError('任务状态已改变；未提交消息。')
        submitted = true
        const res = await io.call(route, 'prompt.submit', {
          session_id: sid, ...prepared, submission_id: `${ID}:${job.id}`, queued: true,
        })
        if (!accepted(res)) throw new Error('missing admission acknowledgement')
        await settle('sent', res.status === 'queued' ? '已进入原会话的 Hermes 队列。' : '已获原会话接收回执。', { sentAt: now(), admission: res.admission_id ?? null })
        return true
      } catch (error) {
        await settle('review', submitted ? '未确认 Hermes 是否已接收。为避免重复，请先核对原会话。' : (error?.safe ? error.message : '连接、读回或准备原会话失败；未提交消息。'), { uncertain: submitted })
        return false
      } finally { release() }
    })
  }

  async function recover(cutoff, cold) {
    const marked = await edit(s => {
      // Replayed callbacks / multiple windows can visit a cutoff more than once without double dispatch.
      const before = s.jobs.filter(j => j.status === 'missed').length
      s.jobs = cutoffJobs(s.jobs, cutoff)
      s.cutoff = cutoff
      return cold ? s.jobs.filter(j => j.status === 'missed' || (j.status === 'review' && j.uncertain)).length : s.jobs.filter(j => j.status === 'missed').length - before
    })
    if (marked > 0) notify(`${marked} 条计划消息错过或待核对，可打开「ChatGPT 队列」查看。`, true)
  }
  async function tick(boot = null) {
    if (!active()) return
    const t = now()
    if (lastTick !== null && (t - lastTick > 90 * 1000 || t < lastTick - MIN)) wakeCutoff = t
    lastTick = t
    if (busy) return
    busy = true
    try {
      if (boot !== null) {
        await edit(s => {
          if (s.autoVersion !== 2) { s.auto = true; s.autoVersion = 2 }
          s.jobs = s.jobs.map(j => j.status === 'capturing' || j.status === 'held' ? { ...j, status: 'review', uncertain: true, note: '上次退出时草稿操作未完成；请先核对原草稿，再决定是否删除记录。' } : j)
        })
        const s = await read()
        for (const j of s.jobs.filter(j => j.status === 'sending')) {
          await locks.request(`${ID}:send:${j.id}`, { ifAvailable: true }, async lock => {
            if (!lock) return
            await modify(j.id, entry => entry.status === 'sending' ? {
              ...entry, status: entry.phase === 'submit' ? 'review' : 'missed', uncertain: entry.phase === 'submit',
              note: entry.phase === 'submit' ? '上次退出时未确认投递结果；请查原会话。' : '上次退出时尚未投递。'
            } : null)
          })
        }
        await recover(boot, true)
      } else if (wakeCutoff !== null) {
        const cutoff = wakeCutoff; wakeCutoff = null
        await recover(cutoff, false)
      }
      // Inline dispatch starts only after storage is ready; cap launch fanout per tick.
      const s = await read()
      const due = s.jobs.filter(j => j.status === 'pending' && j.due <= t && (s.auto || j.kind !== 'retry')).sort((a, b) => a.due - b.due).slice(0, 3)
      for (const j of due) { if (active()) await dispatch(j.id) }
    } finally { busy = false }
  }
  return {
    read, tick, dispatch,
    enqueue: job => edit(s => addJob(s, job)),
    commitCapture: (id, due) => modify(id, j => j.status === 'capturing' ? (due > now() ? { ...j, status: 'pending' } : { ...j, status: 'missed', note: '保存期间已超过计划时间。' }) : null),
    abandonCapture: id => edit(s => { s.jobs = s.jobs.filter(j => j.id !== id || j.status !== 'capturing') }),
    enqueueRetry: job => edit(s => s.auto && addJob(s, job)),
    enable: value => edit(s => { s.auto = Boolean(value); s.autoVersion = 2; if (!value) s.jobs = s.jobs.map(j => j.kind === 'retry' && j.status === 'pending' ? { ...j, status: 'missed', note: '自动重试已暂停。' } : j) }),
    holdJob: id => locks.request(`${ID}:send:${id}`, { ifAvailable: true }, lock => !lock ? null : modify(id, j => ['pending', 'missed', 'review'].includes(j.status) && !j.uncertain ? { ...j, status: 'held', previousStatus: j.status } : null)),
    releaseJob: id => modify(id, j => j.status === 'held' ? { ...j, status: j.previousStatus === 'pending' && j.due <= now() ? 'missed' : j.previousStatus || 'review', previousStatus: null } : null),
    finishCancel: (id, restored) => modify(id, j => j.status === 'held' ? { ...withoutBody(j), status: restored ? 'restored' : 'canceled', previousStatus: null, note: null, ...(restored ? {} : { summary: '' }) } : null),
    cancel: id => modify(id, j => ['pending', 'missed', 'review'].includes(j.status) ? { ...withoutBody(j), summary: '', status: 'canceled', note: null } : null),
  }
}

const snapshotFocus = () => ({
  owner: host.state.focusedSessionOwner?.get(), runtime: host.state.focusedSessionId?.get() || null,
  stored: host.state.focusedStoredSessionId?.get() || null, cwd: host.state.cwd?.get() || '',
})
const sameFocus = (a, b) => a.runtime === b.runtime && a.stored === b.stored && a.owner?.connectionId === b.owner?.connectionId && a.owner?.profile === b.owner?.profile
const sessionTitle = (job) => job.session ? `${job.route.profile} · ${job.session}` : `${job.route.profile} · 新对话`
const warn = message => host.notify({ kind: 'error', message })
const toast = message => host.notify({ kind: 'info', message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createIO(hostLike) {
  let cachedAt = 0, routes = null
  async function getRoutes(force = false) {
    if (!force && routes && dateNow() - cachedAt < 20000) return routes
    routes = await hostLike.profileRoutes()
    cachedAt = dateNow()
    return routes
  }
  return {
    resolve: async old => (await getRoutes(true)).find(r => sameRoute(old, r)),
    owner: async owner => owner?.connectionId && (await getRoutes()).find(r => r.mode === 'local' && r.connectionId === owner.connectionId && r.profile === owner.profile),
    call: (route, method, params) => hostLike.requestProfile(route, method, { ...params, profile: route.targetProfile }),
    hold: (route, foreground) => hostLike.retainProfile(route, foreground ? { spawnPriority: 'foreground' } : undefined),

  }
}

export function createQuotaObserver({ io, scheduler, lookup, active, now = dateNow, pause = wait, notify = toast }) {
  const inProgress = new Set()
  return async ev => {
    const p = ev?.payload, s = p?.error_surface
    const userRow = p?.persisted_turn?.user_row_id
    if (ev?.replayed || !ev?.session_id || !s?.model || s.provider !== PROVIDER || s.code !== 'rate_limit' || p.status !== 'error' || p.paused
      || !Number.isSafeInteger(userRow) || userRow <= 0 || !Number.isFinite(s.resets_at) || s.resets_at * 1000 < now()) return false
    const observation = `${ev.connectionId || 'local'}:${ev.profile || ''}:${ev.session_id}:${userRow}`
    if (inProgress.has(observation)) return false
    inProgress.add(observation)
    try {
      if (!active() || !(await scheduler.read()).auto) return false
      const found = await lookup(ev)
      if (!found) return false
      const { route, session } = found
      if (!route || !session || !profileMatch(ev.profile, route) || (ev.connectionId && ev.connectionId !== route.connectionId)) return false
      const release = await io.hold(route, false)
      try {
        const info = await io.call(route, 'session.info', { session_id: ev.session_id })
        if (info?.provider !== PROVIDER || info.model !== s.model || info.yolo || info.archived) return false
        const history = await io.call(route, 'session.transcript', { session_id: session, order: 'latest', limit: 16 })
        const row = latestUser(history), text = rowText(row)
        if (idOf(row) !== userRow || !validText(text) || row.display_kind === 'hidden' || !active()) return false
        let account = quotaView(await io.call(route, 'model.options', { session_id: ev.session_id }))
        let due = eligibleQuotaError(p, account, now())
        if (due === null && active() && account.seen && !account.accounts.length) {
          const live = await io.call(route, 'session.account_usage', { session_id: ev.session_id }).catch(() => null)
          due = confirmedFromAccountUsage(p, account, live, now())
          if (due === null && active()) {
            await pause(2000)
            account = quotaView(await io.call(route, 'model.options', { session_id: ev.session_id }))
            due = eligibleQuotaError(p, account, now())
          }
        }
        if (due === null || !active()) return false
        const added = await scheduler.enqueueRetry({ id: `retry:${route.connectionId}:${route.profile}:${session}:${userRow}`, route, session,
          kind: 'retry', model: s.model, userRow, text, summary: summary(text), due, created: now(), status: 'pending' })
        if (added) notify(`已确认 ChatGPT 5 小时额度耗尽；原会话计划 ${displayTime(due, now())} 续跑。`)
        return added
      } finally { release() }
    } finally { inProgress.delete(observation) }
  }
}

const small = { fontSize: 12, color: 'var(--ui-text-secondary)', lineHeight: 1.55 }
const stack = { display: 'grid', gap: 10, minWidth: 0 }
const wrap = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
const rawText = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 0', maxHeight: '15vh', overflow: 'auto', fontFamily: 'inherit' }
const btn = (label, onClick, disabled = false, key = label) => jsx(Button, { type: 'button', variant: 'outline', size: 'sm', disabled, onClick, children: label }, key)
const dialog = (open, close, title, desc, children) => jsx(Dialog, {
  open, onOpenChange: value => { if (!value) close() }, children: jsxs(DialogContent, { children: [
    jsxs(DialogHeader, { children: [jsx(DialogTitle, { children: title }), jsx(DialogDescription, { children: desc })] }),
    jsx('div', { style: { ...stack, maxHeight: '65vh', overflowY: 'auto', padding: '2px' }, children }),
  ] }),
})

function useQueue(service) {
  const [state, set] = useState(null)
  useEffect(() => {
    let gone = false
    const refresh = () => service.scheduler.read().then(s => { if (!gone) set(s) }, () => { if (!gone) set(null) })
    const detach = service.subscribe(refresh)
    void refresh()
    const interval = setInterval(refresh, 5000)
    return () => { gone = true; detach(); clearInterval(interval) }
  }, [service])
  return state
}

function QueueContents({ service, close }) {
  const state = useQueue(service)
  const [showHistory, toggle] = useState(false)
  const [askAuto, confirmAuto] = useState(false)
  const [working, setWorking] = useState(null)
  const run = async (key, action) => {
    if (working) return
    try { setWorking(key); await action() } catch (e) { warn(e?.safe ? e.message : '队列操作失败；请查看原会话后再决定是否重试。') }
    finally { setWorking(null) }
  }
  if (!state) return jsx('p', { role: 'status', children: '正在读取本机队列；若长期无响应，请确认桌面端允许本机存储。' })
  const jobs = state.jobs.filter(j => showHistory || PENDING.has(j.status)).sort((a, b) => Number(PENDING.has(b.status)) - Number(PENDING.has(a.status)) || a.due - b.due)
  return jsxs('div', { style: stack, children: [
    jsxs('div', { style: wrap, children: [
      btn(state.auto ? '暂停自动续跑' : '启用 5 小时额度自动续跑', () => state.auto ? void run('auto', () => service.scheduler.enable(false)) : confirmAuto(true), Boolean(working)),
      btn(showHistory ? '隐藏历史' : '显示历史', () => toggle(v => !v)),
    ] }),
    askAuto && !state.auto ? jsxs('div', { style: stack, children: [
      jsx('p', { style: small, children: '启用后，已确认的 ChatGPT 5 小时限额会在原会话自动续跑，消耗 ChatGPT 订阅额度，并沿用原会话的工具和审批设置。不会自动批准权限请求。' }),
      jsxs('div', { style: wrap, children: [btn('确认启用', () => void run('auto', async () => { await service.scheduler.enable(true); confirmAuto(false) }), Boolean(working)), btn('先不开启', () => confirmAuto(false))] }),
    ] }) : null,
    !jobs.length ? jsx('p', { style: small, children: '没有要处理的消息。' }) : null,
    ...jobs.map(j => jsxs('section', { style: { ...stack, gap: 5, paddingTop: 8, borderTop: '1px solid var(--ui-stroke-secondary)' }, children: [
      jsx('strong', { children: `${LABEL[j.status] ?? j.status} · ${j.kind === 'retry' ? '额度续跑' : j.kind === 'window' ? '下个额度窗口' : '定时'} · ${displayTime(j.due, dateNow())}` }),
      jsx('div', { style: small, children: `${sessionTitle(j)} · ${j.model}` }),
      jsx('div', { style: { overflowWrap: 'anywhere' }, children: `摘要：${j.summary}` }),
      j.text ? jsxs('details', { children: [jsx('summary', { children: '对话消息全文' }), jsx('pre', { style: rawText, children: j.text })] }) : null,
      j.note ? jsx('div', { style: small, children: j.note }) : null,
      jsxs('div', { style: wrap, children: [
        ['missed', 'review'].includes(j.status) && !j.uncertain ? btn('立即发送', () => void run(j.id, async () => { if (await service.scheduler.dispatch(j.id, true)) toast('消息已交给 Hermes 原会话。') }), Boolean(working)) : null,
        j.session ? btn('打开原会话', () => void run(j.id, async () => {
          const route = await service.io.resolve(j.route)
          if (!route) throw softError('无法定位原会话所属的本地 profile。')
          await host.openSession(j.session, { route }); close()
        }), Boolean(working)) : null,
        ['pending', 'missed', 'review'].includes(j.status) ? btn('取消计划', () => void run(j.id, () => service.scheduler.cancel(j.id)), Boolean(working)) : null,
      ] }),
    ] }, j.id)),
  ] })
}

function QueueStatus({ service }) {
  const state = useQueue(service)
  const [open, setOpen] = useState(false)
  useEffect(() => service.onRecovery(() => setOpen(true)), [service])
  const outstanding = state?.jobs.filter(j => ['missed', 'review'].includes(j.status)).length ?? 0
  return jsxs('div', { children: [
    jsx('button', { type: 'button', title: '打开 ChatGPT 定时发送和漏跑队列', onClick: () => setOpen(true), style: { ...small, cursor: 'pointer', padding: '0 8px' }, children: `ChatGPT 队列${outstanding ? ` · ${outstanding} 待处理` : ''}` }),
    open ? dialog(true, () => setOpen(false), 'ChatGPT 队列', `${EDITION}｜本机所有已计划消息；投递不会切换当前前台会话。`, jsx(QueueContents, { service, close: () => setOpen(false) })) : null,
  ] })
}

const attachmentNotice = '此输入框有附件或内联引用。定时队列只发送纯文字；请移除附件后再排队，或使用 Hermes 的普通发送。正文和附件均未移动。'
const ROOT = '[data-slot="composer-root"]'
const INPUT = '[data-slot="composer-rich-input"]'
const isBlank = draft => draft && !draft.text.trim() && !draft.hasAttachments
const sameDraft = (a, b) => Boolean(a && b && a.editor === b.editor && a.text === b.text && a.markup === b.markup && a.hasAttachments === b.hasAttachments)
const boundedError = e => e?.safe ? e.message : '操作未完成；没有自动发送。请检查原草稿和队列。'

// Standalone SDK does not expose attachment count. Probe only native DOM slot
// markers within the triggering composer; all text reads/writes use the SDK.
// A second mounted composer is ambiguous (first claimant on the draft bus).
export function inspectComposer(anchor) {
  const root = anchor?.closest(ROOT)
  if (!root?.isConnected) return null
  const scope = root.querySelector('[data-slot="composer-surface"] [data-slot="composer-fade"]')
  const editors = scope?.querySelectorAll(INPUT)
  if (editors?.length !== 1) return null
  const editor = editors[0]
  const hasAttachments = Boolean(scope.querySelector('[data-slot="composer-attachments"]') || editor.querySelector('[data-ref-text], [data-ref-kind], img, audio, video, canvas, [contenteditable="false"]'))
  const candidates = root.ownerDocument.querySelectorAll(`${ROOT} ${INPUT}`)
  const editable = candidates.length === 1 && candidates[0] === editor && editor.getAttribute('contenteditable') === 'true' && editor.getClientRects().length > 0
  return { root, editor, hasAttachments, editable, markup: editor.innerHTML }
}

function scopedComposer(anchor, focus, active) {
  const id = focus.stored || focus.runtime || 'new'
  const target = inspectComposer(anchor)
  const probe = () => {
    if (!active() || !sameFocus(focus, snapshotFocus())) return null
    const view = inspectComposer(anchor)
    return view?.editor === target?.editor && view?.root === target?.root ? view : null
  }
  const read = async () => {
    const view = probe()
    if (!view?.editable || !host.composer?.getDraft || !host.composer?.setDraft) return null
    if (view.hasAttachments) return { ...view, text: '' }
    const text = (await host.composer.getDraft(id)) ?? ''
    const fresh = probe()
    return fresh?.editable && !fresh.hasAttachments && fresh.markup === view.markup ? { ...view, text } : null
  }
  return { read, async replace(expected, text) {
    const current = await read()
    if (!sameDraft(expected, current) || current.hasAttachments) return false
    // No await between the last scope check and the synchronous SDK dispatch.
    const fresh = probe()
    if (!fresh?.editable || fresh.hasAttachments || fresh.markup !== current.markup) return false
    return host.composer.setDraft(id, text)
  } }
}
const iconButton = (label, glyph, props = {}) => jsx('button', {
  type: 'button', title: label, 'aria-label': label,
  className: 'inline-grid size-7 shrink-0 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground disabled:opacity-50',
  ...props, children: glyph,
})
const resetArrow = jsx('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, children: [
    jsx('path', { d: 'M20 10a8 8 0 1 0-2 7' }, 'loop'),
    jsx('path', { d: 'M20 4v6h-6M14 22l7-3-7-3v6z' }, 'send'),
  ] })

export async function moveDraftToQueue({ composer, scheduler, target, due, mode, match, now = dateNow, id = crypto.randomUUID() }) {
  const before = await composer.read()
  if (before?.hasAttachments) return null
  if (!before) throw softError('不能安全确认当前输入框；原草稿未移动。')
  if (!before.text.trim()) throw softError('输入框没有可排队的文字。')
  if (before.text.length > MAX_TEXT) throw softError('文字太长，请先缩短草稿。')
  if (/^\s*\/[^\s/]+/.test(before.text)) throw softError('斜杠命令请用 Hermes 的普通发送。')
  if (!match() || due <= now()) throw softError('会话已切换或计划时间已过，原草稿未移动。')
  const item = { id, kind: mode, route: target.route, session: target.stored, cwd: target.cwd, model: target.model,
    text: before.text.trim(), summary: summary(before.text),
    created: now(), due, status: 'capturing' }
  if (!(await scheduler.enqueue(item))) throw softError('未保存计划，原草稿未移动。')
  if (!match() || due <= now() || !(await composer.replace(before, ''))) {
    await scheduler.abandonCapture(id)
    if ((await composer.read())?.hasAttachments) return null
    throw softError('保存时原草稿发生变化，未移动任何内容。')
  }
  // If a crash occurs after the clear but before this commit, the original
  // capture remains durable and enters manual review, never silent auto-send.
  if (!(await scheduler.commitCapture(id, due))) throw softError('草稿快照仍在队列中，需人工核对后处理。')
  return id
}

function SchedulePopover({ confirm, busy, quota, close }) {
  const [base] = useState(dateNow)
  const [now, setNow] = useState(dateNow)
  const [delay, setDelay] = useState(30)
  useEffect(() => { const clock = setInterval(() => setNow(dateNow()), 1000); return () => clearInterval(clock) }, [])
  const min = Math.min(1440, Math.max(1, Math.floor((now - base + base % MIN) / MIN) + 1))
  const current = Math.max(min, delay)
  const due = schedulePoint(base, current)
  const slider = (name, value) => jsxs('label', { style: { display: 'grid', gap: 2 }, children: [
    jsx('span', { children: `${name}：${value}` }),
    jsx('input', { type: 'range', min, max: 1440, value: current, 'aria-label': name, 'aria-valuetext': value,
      onChange: e => setDelay(Number(e.currentTarget.value)), style: { width: '100%', accentColor: 'var(--ui-accent)' } }),
  ] })
  // Hermes can restore the editor caret after an attachment chip disappears.
  // Keep that programmatic focus move from immediately dismissing this popover.
  return jsxs(PopoverContent, { align: 'end', side: 'top', sideOffset: 8, onFocusOutside: e => e.preventDefault(), className: 'w-[min(20rem,90vw)] p-3 text-sm', 'aria-label': '选择发送时间', children: [
    jsx('div', { className: 'font-medium', children: '定时发送当前草稿' }),
    jsx('div', { style: small, children: `系统时间 ${fmt(now)}${quota?.five ? ` · 5 小时额度已用 ${quota.five.used}%` : ''}` }),
    jsx('div', { style: { ...stack, margin: '8px 0' }, children: [slider('距离现在', relative(Math.max(0, Math.ceil((due - now) / MIN)))), slider('按系统时间', displayTime(due, now))] }),
    jsxs('div', { style: wrap, children: [btn('加入队列', () => confirm(due), busy || !due || due <= now), btn('关闭', close, busy)] }),
  ] })
}

function ComposerActions({ service }) {
  const anchor = useRef(null)
  const owner = useValue(host.state.focusedSessionOwner)
  const runtime = useValue(host.state.focusedSessionId)
  const stored = useValue(host.state.focusedStoredSessionId)
  const model = useValue(host.state.model)
  const [label, setLabel] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showAttachment, setShowAttachment] = useState(false)
  const working = useRef(false)
  const pinned = useRef(null)
  const profileKey = owner ? `${owner.connectionId}:${owner.profile}` : ''
  const address = { owner, runtime: runtime || null, stored: stored || null }
  useEffect(() => {
    let inactive = false
    const update = () => service.readFocus().then(v => { if (!inactive) setLabel(v) }, () => { if (!inactive) setLabel(null) })
    const evaluate = setTimeout(update, 250)
    const monitor = setInterval(update, 20000)
    const off = service.onFocusChange(update)
    return () => { inactive = true; clearTimeout(evaluate); clearInterval(monitor); off() }
  }, [service, profileKey, runtime, stored, model])
  const current = label?.model && sameFocus(label, address)
  if (!current) return null
  const denyAttachments = () => {
    if (!inspectComposer(anchor.current)?.hasAttachments) return false
    setOpen(false); setShowAttachment(true); return true
  }
  const enqueue = async (mode, chosen = null) => {
    if (working.current || denyAttachments()) return
    try {
      working.current = true; setBusy(true)
      const start = snapshotFocus()
      if (mode === 'timed' && (!pinned.current || !sameFocus(start, pinned.current))) throw softError('会话已切换，请重新选择发送时间。')
      const target = await service.readFocus()
      if (!target || !sameFocus(target, start) || !sameFocus(start, snapshotFocus())) throw softError('当前会话或模型无法确认，原草稿未移动。')
      if (denyAttachments()) return
      const due = mode === 'timed' ? chosen : nextWindow(target.quota, dateNow())
      if (!due || due <= dateNow()) throw softError('Hermes 尚未返回可验证的 5 小时重置时间；原草稿未移动。')
      const composer = scopedComposer(anchor.current, target, service.active)
      const result = await moveDraftToQueue({ composer, scheduler: service.scheduler, target, due, mode, match: () => service.active() && sameFocus(target, snapshotFocus()) })
      if (result === null) { setOpen(false); setShowAttachment(true); return }
      toast(`已排队：${displayTime(due, dateNow())}。`)
      setOpen(false)
    } catch (e) { warn(boundedError(e)) }
    finally { working.current = false; setBusy(false) }
  }
  const onOpen = value => {
    if (working.current) return
    if (value) {
      if (denyAttachments()) return
      if (!inspectComposer(anchor.current)?.editable) { warn('不能安全确认当前输入框，请在单会话视图中重试。'); return }
      pinned.current = snapshotFocus()
    }
    setOpen(value)
  }
  return jsxs('div', { ref: anchor, className: 'inline-flex items-center gap-0.5', children: [
    iconButton('下个 ChatGPT 5 小时窗口发送', resetArrow, { disabled: busy, onClick: () => void enqueue('window') }),
    jsxs(Popover, { open, onOpenChange: onOpen, children: [
      jsx(PopoverTrigger, { asChild: true, children: iconButton('定时发送 ChatGPT 消息', jsx(Codicon, { name: 'calendar', size: 16 }), {
        disabled: busy, onClick: e => { e.preventDefault(); onOpen(!open) },
      }) }),
      open ? jsx(SchedulePopover, { close: () => onOpen(false), busy, quota: label.quota, confirm: due => void enqueue('timed', due) }) : null,
    ] }),
    showAttachment ? dialog(true, () => setShowAttachment(false), '定时队列不支持附件', attachmentNotice,
      btn('知道了', () => setShowAttachment(false))) : null,
  ] })
}

export async function cancelHeldJob({ scheduler, composer, job, choice, log, expected = null, guard = () => true }) {
  if (!guard()) throw softError('原输入框已切换，未覆盖。')
  if (choice === 'restore' || choice === 'override') {
    const before = await composer?.read()
    if (!guard() || !before || before.hasAttachments || job.draft || (choice === 'restore' && !isBlank(before)) ||
      (choice === 'override' && !sameDraft(before, expected))) return false
    if (!(await composer.replace(before, job.kind === 'retry' ? RETRY_TEXT : job.text))) return false
    try {
      if (!(await scheduler.finishCancel(job.id, true))) throw new Error('lost cancellation hold')
    } catch {
      // The editor already contains the message. Keep the queue row held;
      // never release it for dispatch or offer one-click resend on restart.
      throw Object.assign(softError('内容已放回输入框，但取消记录未能确认。请不要重复发送。'), { restored: true })
    }
  } else {
    if (choice !== 'log' && choice !== 'discard') throw softError('无法识别取消操作。')
    if (choice === 'log') await log(job)
    if (!(await scheduler.finishCancel(job.id, false))) throw softError('取消状态发生变化，请核对队列。')
  }
  return true
}

function ComposerQueue({ service }) {
  const { storedSessionId } = useComposerSession()
  const anchor = useRef(null)
  const focusOwner = useValue(host.state.focusedSessionOwner)
  const focusStored = useValue(host.state.focusedStoredSessionId)
  const state = useQueue(service)
  const [conflict, setConflict] = useState(null)
  const [busy, setBusy] = useState(false)
  const held = useRef(null)
  const changing = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (held.current && !changing.current) void service.scheduler.releaseJob(held.current).catch(() => {})
    }
  }, [service])
  const jobs = (state?.jobs ?? []).filter(j => PENDING.has(j.status) && j.status !== 'capturing' && j.route?.connectionId === focusOwner?.connectionId &&
    j.route?.profile === focusOwner?.profile && (j.session || null) === storedSessionId && (focusStored || null) === storedSessionId)
  const settleHold = () => { held.current = null; setConflict(null) }
  const dismiss = async () => {
    if (!conflict || changing.current) return
    try { changing.current = true; await service.scheduler.releaseJob(conflict.job.id); settleHold() }
    catch (e) { warn(boundedError(e)) }
    finally { changing.current = false }
  }
  const applyChoice = async choice => {
    if (!conflict || changing.current) return
    try {
      changing.current = true; setBusy(true)
      if (!(await cancelHeldJob({ scheduler: service.scheduler, composer: conflict.composer, job: conflict.job, choice, log: service.logCancellation,
        expected: conflict.before, guard: () => mounted.current && service.active() && (!['restore', 'override'].includes(choice) || sameFocus(conflict.focus, snapshotFocus())) }))) {
        const fresh = await conflict.composer.read()
        if (!fresh) throw softError('原输入框不可编辑；未覆盖。')
        setConflict({ ...conflict, before: fresh }); warn('确认期间草稿有变化。请重新选择。'); return
      }
      settleHold()
    } catch (e) { if (e?.restored) settleHold(); warn(boundedError(e)) }
    finally {
      changing.current = false; setBusy(false)
      if (!mounted.current && held.current) void service.scheduler.releaseJob(held.current).catch(() => {})
    }
  }
  const cancel = async j => {
    if (changing.current || held.current) return
    const pinned = snapshotFocus()
    const composer = scopedComposer(anchor.current, pinned, () => mounted.current && service.active())
    try {
      changing.current = true
      const job = await service.scheduler.holdJob(j.id)
      if (!job) throw softError('此消息已经开始投递，或正由另一个窗口处理。')
      held.current = job.id
      if (!mounted.current || !service.active()) {
        await service.scheduler.releaseJob(job.id); held.current = null; return
      }
      const same = sameFocus(pinned, snapshotFocus())
      const before = same ? await composer.read() : null
      if (!job.draft && isBlank(before)) {
        if (await cancelHeldJob({ scheduler: service.scheduler, composer, job, choice: 'restore', guard: () => sameFocus(pinned, snapshotFocus()) })) { settleHold(); return }
      }
      setConflict({ job, focus: pinned, before, composer })
    } catch (e) {
      if (held.current && !e?.restored) await service.scheduler.releaseJob(held.current).catch(() => {})
      settleHold(); warn(boundedError(e))
    } finally { changing.current = false }
  }
  return jobs.length || conflict ? jsxs('div', { ref: anchor, className: 'grid gap-1 pb-1', 'aria-label': '本会话的定时待处理消息', children: [
    ...jobs.map(j => jsxs('div', { className: 'flex min-w-0 items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) px-2 py-1 text-xs', children: [
      jsx(Codicon, { name: 'calendar' }),
      jsx('span', { className: 'shrink-0 text-(--ui-text-secondary)', children: `${LABEL[j.status]} · ${displayTime(j.due, dateNow())}` }),
      jsx('span', { className: 'min-w-0 flex-1 truncate', title: j.summary, children: `${j.summary}${j.attachmentCount && j.text?.trim() ? ` · ${j.attachmentCount} 个附件` : ''}` }),
      ['pending', 'missed', 'review'].includes(j.status) && !j.uncertain ? btn('取消', () => void cancel(j), Boolean(conflict), `cancel-${j.id}`) : null,
    ] }, j.id)),
    conflict ? dialog(true, () => void dismiss(), '取消定时消息', conflict.job.draft ? '旧版附件任务不能退回输入框。你仍可删除计划。' : conflict.before?.hasAttachments ? '当前输入框有附件或内联引用，不覆盖现有草稿；可删除计划，或保留计划后移除附件再试。' : conflict.before ? '当前输入框已有内容。选择覆盖，或保留现有草稿并删除计划。' : '原输入框当前不可编辑。你仍可删除计划。', jsxs('div', { style: wrap, children: [
      conflict.before && !conflict.before.hasAttachments && !conflict.job.draft ? btn('强行覆盖', () => void applyChoice('override'), busy) : null,
      btn('删除，不保存', () => void applyChoice('discard'), busy),
      btn('删除并留日志', () => void applyChoice('log'), busy),
      btn('保留计划', () => void dismiss(), busy),
    ] })) : null,
  ] }) : null
}

export default {
  id: ID, name: 'ChatGPT 定时队列', defaultEnabled: false,
  register(ctx) {
    if (!globalThis.navigator?.locks || !globalThis.indexedDB || !host.state.focusedSessionOwner || !host.profileRoutes || !host.retainProfile || !host.composer) {
      warn('ChatGPT 队列需要支持本地会话路由与持久存储的新版本 Hermes Desktop。未启用调度。')
      return
    }
    const locks = navigator.locks
    const registeredAt = dateNow()
    const db = readIDB()
    const io = createIO(host)
    let stopped = false
    let failureNotified = false
    const active = () => !stopped
    const changeListeners = new Set(), focusListeners = new Set(), recoveryListeners = new Set()
    let recoveryPending = false
    const remember = new Map(), inventoryPending = new Map()
    let stream
    try { stream = new BroadcastChannel(ID) } catch { /* view polling still updates */ }
    const fire = () => { for (const fn of changeListeners) fn() }
    if (stream) stream.onmessage = fire
    const change = () => { fire(); stream?.postMessage(true) }
    const rememberFocus = () => {
      const v = snapshotFocus()
      if (v.runtime && v.stored && v.owner?.connectionId) {
        if (remember.size >= 2000) remember.delete(remember.keys().next().value)
        remember.set(v.runtime, v)
      }
    }
    const scheduler = createScheduler({ io, storage: createStore(db), locks, active, change, notify(message, recover) {
      toast(message)
      if (recover) {
        recoveryPending = recoveryListeners.size === 0
        for (const fn of recoveryListeners) fn()
      }
    } })
    const inventory = (route, runtime) => {
      const key = `${route.connectionId}:${route.profile}:${runtime ?? ''}`
      if (!inventoryPending.has(key)) inventoryPending.set(key, io.call(route, 'model.options', runtime ? { session_id: runtime } : {}).finally(() => inventoryPending.delete(key)))
      return inventoryPending.get(key)
    }
    const service = { scheduler, inventory, io, active, subscribe(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn) },
      async logCancellation(job) {
        if (!ctx.files) throw softError('桌面插件文件接口不可用；计划未删除。')
        const name = `cancelled-${crypto.randomUUID()}.json`
        const body = JSON.stringify({ format: 1, cancelledAt: new Date().toISOString(), scheduledAt: new Date(job.due).toISOString(),
          profile: job.route.profile, model: job.model, text: job.text ?? '',
          attachments: (job.draft?.attachments ?? []).map(({ kind, label }) => ({ kind, label })) }, null, 2) + '\n'
        const result = await ctx.files.writeText('data', name, body, { exclusive: true })
        if (!result?.ok) throw softError('未能写入插件数据目录；计划保留。')
        const verified = await ctx.files.readText('data', name)
        if (!verified?.ok || verified.text !== body) throw softError('无法核实日志内容；计划保留。')
        toast(`已保存取消日志：${name}`)
      },
      onRecovery(fn) { recoveryListeners.add(fn); if (recoveryPending) { recoveryPending = false; fn() } return () => recoveryListeners.delete(fn) },
      onFocusChange(fn) { focusListeners.add(fn); return () => focusListeners.delete(fn) },
      async readFocus() {
        rememberFocus()
        const focus = snapshotFocus(), route = await io.owner(focus.owner)
        if (!route || (focus.stored && !focus.runtime)) return null
        const inv = await inventory(route, focus.runtime)
        const quota = quotaView(inv)
        if (!sameFocus(focus, snapshotFocus()) || inv.provider !== PROVIDER || !inv.model || !quota.seen) return null
        return { ...focus, route, model: inv.model, quota }
      },
    }
    const focusAtoms = ['focusedSessionId', 'focusedStoredSessionId', 'focusedSessionOwner'].map(key => host.state[key].listen(rememberFocus))
    rememberFocus()
    ctx.onEvent('session.info', ev => {
      if (ev.session_id && ev.session_id === host.state.focusedSessionId.get()) for (const fn of focusListeners) fn()
    })
    const observe = createQuotaObserver({ io, scheduler, active, lookup: async ev => {
      rememberFocus()
      const v = remember.get(ev.session_id)
      if (v) {
        const route = await io.owner(v.owner)
        return route ? { route, session: v.stored } : null
      }
      // Canonical gateways tag their owner on shared sockets. Never guess a
      // profile from whichever window/tab happens to be selected now.
      if (!ev.profile) return null
      const route = await io.owner({ connectionId: ev.connectionId || 'local', profile: ev.profile })
      return route ? { route, session: ev.session_id } : null
    } })
    ctx.onEvent('message.complete', ev => { void observe(ev).catch(() => { /* unknown does not auto-send */ }) })
    ctx.register({ id: 'schedule-buttons', area: 'composer.actions', order: 20, render: () => jsx(ComposerActions, { service }) })
    if (useComposerSession) ctx.register({ id: 'session-scheduled-queue', area: 'composer.top', order: 30, render: () => jsx(ComposerQueue, { service }) })
    ctx.register({ id: 'queue-status', area: 'statusBar.right', order: 120, render: () => jsx(QueueStatus, { service }) })
    const onFailure = () => {
      if (!failureNotified && active()) { failureNotified = true; warn('ChatGPT 队列无法打开本地持久存储或调度锁。为避免重复发送，未执行本次扫描。') }
    }
    let stopLeader
    const untilDispose = new Promise(resolve => { stopLeader = resolve })
    void db.catch(onFailure)
    void locks.request(`${ID}:leader`, async () => {
      if (!active()) return
      await scheduler.tick(registeredAt)
      if (!active()) return
      const timer = setInterval(() => { void scheduler.tick().catch(onFailure) }, wakeDelay)
      try { await untilDispose } finally { clearInterval(timer) }
    }).catch(onFailure)
    ctx.onDispose(() => {
      stopped = true; stopLeader(); stream?.close(); stream = null
      for (const off of focusAtoms) off()
      changeListeners.clear(); focusListeners.clear(); recoveryListeners.clear()
      // Do not close the IDB handle here: an in-flight RPC must be able to persist its receipt after a hot reload.
    })
  },
}
