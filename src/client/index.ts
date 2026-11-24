/**
 * dsh-skillmcp-gate — client 侧（0.5.1 对抗审查修复版）。
 * 0.5.1 变更：
 *  - 横条改 diff 计数 + 零差异隐藏（修复「N 项变更待应用」含存量 deny 的语义错位）
 *  - 可用数改为对真实清单过滤计数（修复幽灵条目低报与负数）
 *  - applyDraft 加 in-flight 锁：应用中禁点，完成后保留应用期间的新勾选
 *  - 错误页加重试按钮；load 成功清空草稿（防过期草稿覆盖提交）
 *  - fetch 加 10s 超时（AbortController）
 *  - banner 开关切换前检查未应用草稿
 *  - console 前缀统一用 PKG
 * 命名三分法见 host 文件头：BANNER_KEY 用短名（永久内部标识，永不随包名改）。
 * 不用 JSX：全部 React.createElement（classic runtime），与宿主 ModuleLoader require 映射兼容。
 */
import type { Context } from '@deepseek-ai/cordis'
import React, { useState, useEffect, useCallback, useRef } from 'react'

type SlotsService = {
  inject: (name: string, factory: (...args: any[]) => unknown, key?: string) => (() => void) | void
  register: (spec: Record<string, unknown>, component?: unknown) => (() => void) | void
}

type SidebarTabsService = {
  register(definition: {
    id: string
    kind: string
    multiple?: boolean
    keepMounted?: boolean
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title: (address: string) => string
    guide?: readonly { id: string; order: number; title: () => string; description?: () => string }[]
  }): (() => void) | void
}
type ClientContext = Context & {
  slots?: SlotsService
  sidebarRightTabs?: SidebarTabsService
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

const PKG = 'dsh-skillmcp-gate'
const API = '/skillmcp-gate/api'
const TITLE = 'Skill & MCP'
/** 短名 = 永久内部标识（见 host 文件头命名三分法），禁止改为包名 */
const BANNER_KEY = 'skillmcp-gate:banner-visible'
const FETCH_TIMEOUT_MS = 10000
const h = React.createElement

type ToolRow = { name: string; kind: 'mcp' | 'builtin'; server: string; tool: string; description?: string }
type SkillRow = { name: string; description?: string }
type ToolFailure = { name: string; kind: 'temporary' | 'permanent'; reason: string; fails: number }
type State = {
  sessionId: string
  cwd?: string
  tools: ToolRow[]
  skills: SkillRow[]
  mcpServers: string[]
  global: { deniedTools: string[]; deniedSkills: string[]; releasedTools?: string[]; releasedSkills?: string[] }
  session: { deniedTools: string[]; deniedSkills: string[]; releasedTools?: string[]; releasedSkills?: string[] } | null
  applied: { deniedTools?: number; deniedSkills?: number } | null
  agentLive: boolean
  sessionsIndex?: Record<string, { tools: number; skills: number }>
  /** V2-2：失败分类（permanent = 该会话工具集里没有 / 不可禁，不再重试） */
  failures?: ToolFailure[]
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // 0.5.1：超时防护（host 挂起时不再永久「加载中」）
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(path, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function apiGet(query: string): Promise<State> {
  const res = await apiFetch(`${API}/state${query}`)
  if (!res.ok) throw new Error(`state ${res.status}`)
  return res.json()
}

async function apiSet(body: any): Promise<{ ok?: boolean; partial?: boolean; applied?: any; error?: string }> {
  const res = await apiFetch(`${API}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}) as any)
  if (!res.ok) throw new Error(`set ${res.status}${data?.error ? `: ${data.error}` : ''}`)
  return data
}

// ── 草稿持久化（0.5.5 修复 M6：整页刷新不再丢草稿）────────────────
// sessionStorage = tab 作用域：刷新/前进后退保留，关 tab 即弃——符合草稿的临时意图语义。

function draftStorageKey(sessionId: string | undefined, globalMode: boolean): string {
  return `skillmcp-gate:draft:${globalMode ? 'global' : (sessionId || 'nosession')}`
}

/** 草稿模型：t/s = 禁用集合；rt/rs = 放行集合（V2-1 继承+覆写） */
type DraftModel = { t: Set<string>; s: Set<string>; rt: Set<string>; rs: Set<string> }

function loadDraft(key: string): DraftModel | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { t?: unknown; s?: unknown; rt?: unknown; rs?: unknown }
    if (!parsed || typeof parsed !== 'object') return null
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return {
      t: new Set(strs(parsed.t)),
      s: new Set(strs(parsed.s)),
      rt: new Set(strs(parsed.rt)),
      rs: new Set(strs(parsed.rs)),
    }
  } catch { return null }
}

function saveDraft(key: string, draft: DraftModel | null): void {
  try {
    if (draft) window.sessionStorage.setItem(key, JSON.stringify({ t: [...draft.t], s: [...draft.s], rt: [...draft.rt], rs: [...draft.rs] }))
    else window.sessionStorage.removeItem(key)
  } catch { /* 存储不可用（隐私模式）时草稿仅内存态 */ }
}

function bannerEnabled(): boolean {
  try { return window.localStorage.getItem(BANNER_KEY) === '1' } catch { return false }
}

/** 集合等价（0.5.1：in-flight 完成后判断 draft 是否等于提交快照） */
function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// ── React 面板 ──────────────────────────────────────────────────────

function GatePanel(props: { sessionId?: string; globalMode?: boolean }): React.ReactElement {
  const { sessionId, globalMode = false } = props
  const [st, setSt] = useState<State | null>(null)
  /** 稳定引用：applyDraft 的闭包里需要读最新 state（st 在闭包内可能为 null） */
  const stRef = useRef<State | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null)
  // 0.5.5（r2a 建议 #8）：列表搜索过滤
  const [filter, setFilter] = useState('')
  const appliedTimerRef = useRef<number | null>(null)
  const flashAppliedMsg = (msg: string): void => {
    setAppliedMsg(msg)
    if (appliedTimerRef.current !== null) window.clearTimeout(appliedTimerRef.current)
    appliedTimerRef.current = window.setTimeout(() => setAppliedMsg(null), 3000)
  }
  /** 草稿：勾选只改本地，点"应用"才批量提交（减少缓存失效次数）；sessionStorage 持久化（0.5.5 修复 M6） */
  const draftKey = draftStorageKey(sessionId, globalMode)
  const [draft, setDraft] = useState<DraftModel | null>(() => loadDraft(draftKey))
  useEffect(() => {
    saveDraft(draftKey, draft)
    // 0.5.5（r2a 建议 #5）：同 tab 多实例（侧栏 + banner）共享同一把 session 草稿键——
    // 自定义事件同步（sessionStorage 无 storage 事件）；值相同时不回设，避免环
    try { window.dispatchEvent(new CustomEvent('skillmcp-gate:draft-changed', { detail: { key: draftKey } })) } catch { /* ignore */ }
  }, [draftKey, draft])
  useEffect(() => {
    const handler = (e: any): void => {
      if (e?.detail?.key !== draftKey) return
      const next = loadDraft(draftKey)
      setDraft((cur) => {
        const same = (cur === null && next === null)
          || (cur !== null && next !== null && setEquals(cur.t, next.t) && setEquals(cur.s, next.s)
              && setEquals(cur.rt, next.rt) && setEquals(cur.rs, next.rs))
        return same ? cur : next
      })
    }
    window.addEventListener('skillmcp-gate:draft-changed', handler as EventListener)
    return () => window.removeEventListener('skillmcp-gate:draft-changed', handler as EventListener)
  }, [draftKey])
  const reloadRef = useRef<() => void>(() => {})

  const load = useCallback(async (): Promise<void> => {
    try {
      setErr(null)
      const next = await apiGet(`?sessionId=${encodeURIComponent(sessionId ?? '')}`)
      setSt(next)
      stRef.current = next
      // 0.5.2 修复（UI 回归用例 2 阻断项）：load 不再无条件清 draft——
      // 0.5.1 的「load 成功清草稿」会把 applyDraft 完成后保留的增量勾选一并吞掉。
      // 草稿保留后横条 diff 基于“新 applied vs draft”计算，语义仍自洽；
      // 跨会话的草稿清理移至 sessionId 变化的 useEffect（见下）。
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    }
  }, [sessionId])

  const prevSidRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    // 切换会话时草稿跨会话无意义——清空（挂载时不清：刚从 sessionStorage 恢复的草稿要保留）
    const prev = prevSidRef.current
    prevSidRef.current = sessionId
    if (prev !== undefined && prev !== sessionId) setDraft(null)
    void load()
  }, [load, sessionId])
  reloadRef.current = () => { void load() }

  const applyDraft = useCallback(async (): Promise<void> => {
    if (!draft || applying) return // 0.5.1：in-flight 锁
    const snapshot = { t: new Set(draft.t), s: new Set(draft.s), rt: new Set(draft.rt), rs: new Set(draft.rs) } // 锁定提交快照
    setApplying(true)
    try {
      setErr(null)
      let data: { ok?: boolean; partial?: boolean; applied?: any }
      if (globalMode) {
        data = await apiSet({
          scope: 'global',
          deniedTools: [...snapshot.t],
          deniedSkills: [...snapshot.s],
          releasedTools: [],
          releasedSkills: [],
        })
      } else {
        // V2-1：会话 scope = 继承 + 覆写——denied* 是本会话禁用，released* 是本会话放行
        // （放行一个全局默认禁用的 skill）。服务端 effective() 计算 (global ∪ session.denied) − released。
        // V2-3 修复（rv2-ui 中危）：服务端已有但当前视图不可见的禁用项必须保留——
        //   否则「批量应用」的全量回写会静默丢弃它们（被禁工具因 restrict 不在清单里）。
        const currentSession = stRef.current?.session
        const serverDeniedTools = new Set(currentSession?.deniedTools ?? [])
        const keepTools = [...snapshot.t]
        for (const n of serverDeniedTools) if (!keepTools.includes(n)) keepTools.push(n)
        const serverDeniedSkills = new Set(currentSession?.deniedSkills ?? [])
        const keepSkills = [...snapshot.s]
        for (const n of serverDeniedSkills) if (!keepSkills.includes(n)) keepSkills.push(n)
        data = await apiSet({
          scope: 'session',
          sessionId,
          deniedTools: keepTools,
          deniedSkills: keepSkills,
          releasedTools: [...snapshot.rt],
          releasedSkills: [...snapshot.rs],
        })
      }
      await load()
      // 0.5.5 修复 L3：应用结果显式反馈（消费 host 0.5.5 的真实聚合——partial 提示后台重试）
      const isPartial = data?.partial === true || data?.applied?.result?.partial === true
      flashAppliedMsg(isPartial ? '⚠ 已应用：部分工具暂未生效（将自动重试）' : '✓ 已应用')
      // 0.5.1：应用期间的新勾选不吞——仅当 draft 仍等于提交快照时清空，否则保留增量
      setDraft((prev) => {
        if (!prev) return null
        if (setEquals(prev.t, snapshot.t) && setEquals(prev.s, snapshot.s)
            && setEquals(prev.rt, snapshot.rt) && setEquals(prev.rs, snapshot.rs)) return null
        return prev
      })
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally {
      setApplying(false)
    }
  }, [draft, applying, globalMode, sessionId, load])

  if (err !== null && st === null) {
    // 0.5.1：错误页加重试入口（不再卡死到组件重挂）。
    // 0.5.5 修复 bug③：已有数据时（st 非 null）不再整块替换为错误页——降级为内联错误条。
    return h('div', { style: { padding: 10 } },
      h('div', { style: { color: '#f66', marginBottom: 8 } }, `加载失败：${err}`),
      h('button', {
        onClick: () => void reloadRef.current(),
        style: { padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(127,127,127,.4)', cursor: 'pointer', background: 'transparent', color: 'inherit', fontSize: 12 },
      }, '重试'),
    )
  }
  if (st === null) {
    return h('div', { style: { padding: 10, opacity: 0.6 } }, '加载中…')
  }

  // 已生效集合（global + session 合并；V2-1：含 released 抵消）
  const appliedT = new Set(st.global.deniedTools)
  const appliedS = new Set(st.global.deniedSkills)
  const relT = new Set(st.global.releasedTools ?? [])
  const relS = new Set(st.global.releasedSkills ?? [])
  if (!globalMode && st.session) {
    for (const x of st.session.deniedTools) appliedT.add(x)
    for (const x of st.session.deniedSkills) appliedS.add(x)
    for (const x of st.session.releasedTools ?? []) relT.add(x)
    for (const x of st.session.releasedSkills ?? []) relS.add(x)
  }
  for (const x of relT) appliedT.delete(x)
  for (const x of relS) appliedS.delete(x)
  // 渲染视图：有 draft 时勾选框/删除线/计数立即反映用户选择（生效仍等「批量应用」）——0.4.4
  const deniedT = draft !== null ? draft.t : appliedT
  const deniedS = draft !== null ? draft.s : appliedS

  // V2-1：会话 scope 支持「本会话放行」——勾选一个「全局默认已禁用」的项 = 本会话放行
  // （写 released*）；全局 scope 下无放行概念（勾选=可用即取消禁用）。
  const baseModel = (): DraftModel => draft ?? {
    t: new Set(appliedT),
    s: new Set(appliedS),
    rt: new Set(relT),
    rs: new Set(relS),
  }
  /** 切换某项的禁用/放行状态（会话 scope 支持放行；全局 scope 只切换禁用） */
  const toggleItem = (kind: 't' | 's', name: string, denied: boolean): void => {
    const base = baseModel()
    const nextD = new Set(kind === 't' ? base.t : base.s)
    const nextR = new Set(kind === 't' ? base.rt : base.rs)
    const inheritedDenied = kind === 't'
      ? (st.global.deniedTools.includes(name) && !(st.global.releasedTools ?? []).includes(name))
      : (st.global.deniedSkills.includes(name) && !(st.global.releasedSkills ?? []).includes(name))
    if (denied) {
      nextD.add(name)
      nextR.delete(name)
    } else {
      nextD.delete(name)
      // 会话 scope：全局默认禁用的项，本会话取消勾选 = 放行（released）
      if (!globalMode && inheritedDenied) nextR.add(name)
      else nextR.delete(name)
    }
    setDraft(kind === 't'
      ? { t: nextD, s: new Set(base.s), rt: nextR, rs: new Set(base.rs) }
      : { t: new Set(base.t), s: nextD, rt: new Set(base.rt), rs: nextR })
  }

  const setTool = (name: string, denied: boolean): void => toggleItem('t', name, denied)
  const setSkill = (name: string, denied: boolean): void => toggleItem('s', name, denied)
  const setServer = (server: string, denyAll: boolean): void => {
    const base = baseModel()
    const next = new Set(base.t)
    for (const t of st.tools.filter((x) => x.kind === 'mcp' && x.server === server)) {
      if (denyAll) next.add(t.name)
      else next.delete(t.name)
    }
    setDraft({ t: next, s: new Set(base.s), rt: new Set(base.rt), rs: new Set(base.rs) })
  }
  // 0.5.5 修复 M7：Skill 组与 MCP server 组同款整组勾选（语义一致，恢复不再反向操作）
  const setAllSkills = (denyAll: boolean): void => {
    const base = baseModel()
    const next = new Set(base.s)
    for (const s of st.skills) {
      if (denyAll) next.add(s.name)
      else next.delete(s.name)
    }
    setDraft({ t: new Set(base.t), s: next, rt: new Set(base.rt), rs: new Set(base.rs) })
  }

  // 0.5.5（r2b 建议 #8）：列表搜索过滤（仅过滤行显示；计数仍为全量口径）
  const fq = filter.trim().toLowerCase()
  const rowMatch = (name: string, desc?: string): boolean =>
    fq === '' || name.toLowerCase().includes(fq) || (desc ?? '').toLowerCase().includes(fq)

  const mcpRows = st.tools.filter((t) => t.kind === 'mcp' && rowMatch(t.name, t.description))
  // 0.5.5 修复（rv-ui P1）：状态行计数恒为全量口径（搜索只过滤行显示，不缩水分母/分子）
  const mcpTotal = st.tools.filter((t) => t.kind === 'mcp').length
  const mcpAvailable = st.tools.filter((t) => t.kind === 'mcp' && !deniedT.has(t.name)).length
  const skillAvailable = st.skills.filter((s) => !deniedS.has(s.name)).length
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }
  const groupStyle = { margin: '8px 0', border: '1px solid rgba(127,127,127,.25)', borderRadius: 6, padding: '6px 8px' }

  const serverGroups = st.mcpServers.map((server: string) => {
    const serverTools = mcpRows.filter((t) => t.server === server)
    if (fq !== '' && serverTools.length === 0) return null // 搜索时隐藏无匹配组
    const serverAll = st.tools.filter((x) => x.kind === 'mcp' && x.server === server)
    const serverAvailable = serverAll.filter((t) => !deniedT.has(t.name)).length
    const allDenied = serverAvailable === 0 && serverAll.length > 0
    const toolRows = serverTools.map((t: ToolRow) =>
      h('label', { key: t.name, style: rowStyle, title: `${t.name}${t.description ? ' — ' + t.description.slice(0, 140) : ''}` },
        h('input', {
          type: 'checkbox',
          checked: !deniedT.has(t.name),
          onChange: (e: any) => setTool(t.name, !e.target.checked),
        }),
        h('span', {
          style: {
            textDecoration: deniedT.has(t.name) ? 'line-through' : 'none',
            opacity: deniedT.has(t.name) ? 0.55 : 1,
          },
        }, t.tool),
      ),
    )
    return h('div', { key: server, style: groupStyle },
      h('label', { style: { ...rowStyle, fontWeight: 600 }, title: '勾选=整组可用；取消=整组禁用' },
        h('input', {
          type: 'checkbox',
          checked: !allDenied,
          onChange: (e: any) => setServer(server, !e.target.checked),
        }),
        // 0.5.5（r2b 建议 #3）：全禁状态醒目提示
        h('span', null, `MCP · ${server}（${serverAvailable}/${serverAll.length} 可用）${allDenied ? ' ⚠ 全部禁用' : ''}`),
      ),
      h('div', { style: { margin: '2px 0 0 18px' } }, toolRows),
    )
  })

  // V2-3：内置工具组（agent 作用域视图里的非 MCP 工具——pwsh/read/grep/web_search 等）
  const builtinAll = st.tools.filter((t) => t.kind !== 'mcp')
  const builtinRows = builtinAll.filter((t) => rowMatch(t.name, t.description)).map((t: ToolRow) =>
    h('label', { key: t.name, style: rowStyle, title: `${t.name}${t.description ? ' — ' + t.description.slice(0, 140) : ''}` },
      h('input', {
        type: 'checkbox',
        checked: !deniedT.has(t.name),
        onChange: (e: any) => setTool(t.name, !e.target.checked),
      }),
      h('span', {
        style: {
          textDecoration: deniedT.has(t.name) ? 'line-through' : 'none',
          opacity: deniedT.has(t.name) ? 0.55 : 1,
        },
      }, t.tool),
    ),
  )
  const builtinAvailable = builtinAll.filter((t) => !deniedT.has(t.name)).length

  const skillRows = st.skills.filter((sk: SkillRow) => rowMatch(sk.name, sk.description)).map((sk: SkillRow) =>
    h('label', { key: sk.name, style: rowStyle, title: `${sk.name}${sk.description ? ' — ' + sk.description.slice(0, 140) : ''}` },
      h('input', {
        type: 'checkbox',
        checked: !deniedS.has(sk.name),
        onChange: (e: any) => setSkill(sk.name, !e.target.checked),
      }),
      h('span', {
        style: {
          textDecoration: deniedS.has(sk.name) ? 'line-through' : 'none',
          opacity: deniedS.has(sk.name) ? 0.55 : 1,
        },
      }, sk.name),
    ),
  )

  // 0.5.1 修复 M-4：状态行语义正确（「应用后」预览用目标集计算）。
  // 0.5.5（r2 双报告建议 #1/高危文案矛盾）：按项分别标注作用域——MCP=本会话、Skill=全局，
  // 草稿态不再把 Skill 误标成「本会话」。
  const statusLine = draft !== null
    ? globalMode
      ? `应用后（全局默认）：${mcpAvailable}/${mcpTotal} MCP · ${builtinAvailable}/${builtinAll.length} 内置 · ${skillAvailable}/${st.skills.length} Skill（新会话继承）`
      : `应用后：${mcpAvailable}/${mcpTotal} MCP（本会话）· ${builtinAvailable}/${builtinAll.length} 内置（本会话）· ${skillAvailable}/${st.skills.length} Skill（全局）${st.agentLive ? '' : ' · 下条消息唤醒时生效'}`
    : globalMode
      ? `全局默认：${mcpAvailable}/${mcpTotal} MCP · ${builtinAvailable}/${builtinAll.length} 内置 · ${skillAvailable}/${st.skills.length} Skill（新会话继承）`
      : `下条消息生效：${mcpAvailable}/${mcpTotal} MCP（本会话）· ${builtinAvailable}/${builtinAll.length} 内置（本会话）· ${skillAvailable}/${st.skills.length} Skill（全局）${st.agentLive ? '' : ' · 下条消息唤醒时生效'}`

  // 0.5.1 修复 M-4：横条 = 双向 diff 计数，零差异隐藏（存量 deny 不再计入）
  // V2-1：加入放行集合（rt/rs）的 diff
  let diffCount = 0
  if (draft !== null) {
    for (const n of draft.t) if (!appliedT.has(n)) diffCount += 1
    for (const n of appliedT) if (!draft.t.has(n)) diffCount += 1
    for (const n of draft.s) if (!appliedS.has(n)) diffCount += 1
    for (const n of appliedS) if (!draft.s.has(n)) diffCount += 1
    for (const n of draft.rt) if (!relT.has(n)) diffCount += 1
    for (const n of relT) if (!draft.rt.has(n)) diffCount += 1
    for (const n of draft.rs) if (!relS.has(n)) diffCount += 1
    for (const n of relS) if (!draft.rs.has(n)) diffCount += 1
  }

  return h('div', {
    style: {
      height: '100%',
      overflowY: 'auto',
      padding: 10,
      fontFamily: 'system-ui, sans-serif',
      fontSize: 12,
    },
  },
    h('div', { style: { fontWeight: 700, fontSize: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', { style: { fontSize: 16 } }, '⚡'),
      h('span', null, TITLE),
    ),
    h('div', { style: { fontSize: 11, opacity: 0.5, marginBottom: 4 } },
      globalMode
        ? '全局默认（新会话继承）· MCP=全局默认 · Skill=全局生效'
        : `本会话面板${sessionId ? ` · 绑定 …${sessionId.slice(-6)}` : ''} · MCP 勾选只影响当前会话`),
    // 0.5.5 修复 M7：常驻语义图例（勾选=可用，取消=禁用——恢复操作不再反向）
    h('div', { style: { fontSize: 11, opacity: 0.65, marginBottom: 6 } },
      '勾选 = 可用 · 取消勾选 = 禁用 · 改动需「批量应用」后生效'),
    // 0.5.5（r2b bug③）：加载失败但已有数据时降级为内联错误条（不再整块替换面板）
    err !== null && st !== null && h('div', {
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,80,80,.12)', fontSize: 11 },
    },
      h('span', { style: { color: '#f66', flex: 1 } }, `刷新失败：${err}`),
      h('button', {
        onClick: () => void reloadRef.current(),
        style: { padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(127,127,127,.4)', cursor: 'pointer', background: 'transparent', color: 'inherit', fontSize: 11 },
      }, '重试'),
    ),
    // 0.5.5（r2a bug B2 缓解）：空会话提示
    !globalMode && !sessionId && h('div', {
      style: { padding: '4px 8px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,180,0,.15)', fontSize: 11 },
    }, '⚠ 未绑定具体会话——请先在左侧选择或新建一个会话，再回到本面板操作'),
    // 0.5.5（r2a 建议 #8）：搜索框
    h('input', {
      value: filter,
      onChange: (e: any) => setFilter(String(e.target.value ?? '')),
      placeholder: '搜索工具 / 技能…',
      style: {
        width: '100%', padding: '4px 8px', marginBottom: 8, borderRadius: 4,
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', fontSize: 12,
        boxSizing: 'border-box',
      },
    }),
    // V2-2：失败分类告警（permanent = 不可禁/不存在，不再重试）
    (st.failures ?? []).length > 0 && h('div', {
      style: { padding: '6px 8px', marginBottom: 8, borderRadius: 6, fontSize: 11, background: 'rgba(255,120,0,.15)' },
    },
      h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '⚠ 部分项目未能生效'),
      ...(st.failures ?? []).map((f) =>
        h('div', { key: f.name, style: { opacity: 0.85 } },
          `${f.name}：${f.kind === 'permanent' ? '本会话工具集中不存在或不可禁用' : '暂时失败，将自动重试'}`)),
    ),
    h('div', { style: { padding: '6px 8px', marginBottom: 8, borderRadius: 6, background: 'rgba(127,127,127,.15)' } },
      statusLine),
    // 0.5.5 修复 L3：应用结果反馈条（3s 自动消失；partial 提示后台自动重试）
    appliedMsg !== null && h('div', {
      style: {
        padding: '6px 8px', marginBottom: 8, borderRadius: 6, fontSize: 11,
        background: appliedMsg.startsWith('⚠') ? 'rgba(255,180,0,.18)' : 'rgba(80,200,120,.15)',
      },
    }, appliedMsg),
    ...serverGroups,
    // V2-3：内置工具组（随 agent preset 变化）
    builtinAll.length > 0 && h('div', { style: groupStyle },
      h('div', { style: { fontWeight: 600, margin: '2px 0' } },
        `内置工具（${builtinAvailable}/${builtinAll.length} 可用）`),
      ...builtinRows,
      h('div', {
        style: { marginTop: 6, padding: '4px 6px', borderRadius: 4, background: 'rgba(127,127,127,.12)', fontSize: 11 },
      }, '内置工具清单随当前 agent preset 变化；不同会话可能不同。仅管控当前会话'),
    ),
    h('div', { style: groupStyle },
      h('label', {
        style: { ...rowStyle, fontWeight: 600 },
        // 0.5.5（r2a bug B6 缓解）：目录口径说明
        title: '勾选=整组可用；取消=整组禁用。清单为全局技能目录，各会话按预设加载，实际目录可能与此略有差异',
      },
        h('input', {
          type: 'checkbox',
          checked: skillAvailable > 0 || st.skills.length === 0,
          onChange: (e: any) => setAllSkills(!e.target.checked),
        }),
        h('span', null, `Skill（${skillAvailable}/${st.skills.length} 可用）${skillAvailable === 0 && st.skills.length > 0 ? ' ⚠ 全部禁用' : ''}`),
      ),
      ...skillRows,
      h('div', {
        style: {
          marginTop: 6, padding: '4px 6px', borderRadius: 4,
          background: 'rgba(255,180,0,.15)', fontSize: 11,
        },
      }, '⚠ Skill 开关为全局生效：影响所有会话（暂不支持单会话级管控）'),
    ),
    // 横条吸底（0.5.5 r2a 建议 #4）：列表滚动到底也可见「批量应用」
    draft !== null && diffCount > 0 && h('div', {
      style: {
        position: 'sticky', bottom: 0, marginTop: 8,
        padding: '6px 8px', borderRadius: 6,
        background: 'rgba(255,180,0,.28)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      },
    },
      h('span', { style: { fontWeight: 600 } }, `⚠ ${diffCount} 项变更待应用`),
      h('button', {
        onClick: () => void applyDraft(),
        disabled: applying,
        style: {
          padding: '3px 10px', borderRadius: 4, border: 'none', cursor: applying ? 'wait' : 'pointer',
          background: applying ? 'rgba(74,158,255,.5)' : '#4a9eff', color: '#fff', fontSize: 11,
        },
      }, applying ? '应用中…' : '批量应用'),
    ),
    globalMode && h('div', { style: { margin: '8px 0' } },
      h('label', { style: rowStyle, title: '开启后会在会话顶部显示 Skill & MCP 入口；右侧栏始终可用' },
        h('input', {
          type: 'checkbox',
          checked: bannerEnabled(),
          onChange: (e: any) => {
            // 0.5.1：切换刷新前检查未应用草稿（reload 会丢弃 draft）
            if (draft !== null && diffCount > 0 && !window.confirm('有未应用的变更，刷新后将丢弃。继续切换？')) {
              e.target.checked = !e.target.checked
              return
            }
            try { window.localStorage.setItem(BANNER_KEY, e.target.checked ? '1' : '0') } catch { /* ignore */ }
            window.location.reload()
          },
        }),
        h('span', null, '在会话顶部显示入口（切换后自动刷新）'),
      ),
      h('details', { style: { marginTop: 8, opacity: 0.7 } },
        h('summary', { style: { cursor: 'pointer', fontSize: 11 } }, 'debug（store 概要）'),
        h('pre', { style: { fontSize: 10, whiteSpace: 'pre-wrap', margin: '4px 0 0' } },
          JSON.stringify({ global: st.global, sessionsIndex: st.sessionsIndex ?? {} }, null, 2)),
      ),
    ),
  )
}

/** conversation.view / settings.section 共用的组件适配：从 props 尽力取 sessionId */
function GatePanelAdapter(props: any): React.ReactElement {
  const sessionId = String(
    props?.sessionId ?? props?.scope?.sessionId ?? props?.session?.id ?? '',
  )
  return h(GatePanel, { sessionId, globalMode: props?.globalMode === true })
}

// ── apply ───────────────────────────────────────────────────────────

export function apply(ctx: ClientContext): void {
  const slots = (ctx as any).slots as SlotsService | undefined
  if (!slots) return // 无渲染器组合（headless）下跳过

  const regs: Array<[string, () => void]> = [
    ['conversation.view', () => {
      if (!bannerEnabled()) return // 默认不挂 banner；设置页开关打开后才注册
      slots.inject('conversation.view', () =>
        slots.register({
          name: 'conversation.view',
          id: `${PKG}:panel-view`,
          order: 10,
          label: () => TITLE,
          inject: (sessionId: any): any => ({ sessionId: String(sessionId ?? '') }),
        }, function GateView(props: any): any {
          return h(GatePanel, {
            sessionId: String(props?.sessionId ?? ''),
            globalMode: false,
          })
        }))
    }],
    ['settings.section', () => {
      slots.inject('settings.section', () =>
        slots.register({
          name: 'settings.section',
          id: `${PKG}:settings`,
          label: () => `${TITLE} 管控`,
          inject: (): any => ({ globalMode: true }),
        }, function GateSettings(props: any): any {
          return h(GatePanel, { globalMode: props?.globalMode === true })
        }))
    }],
  ]
  for (const [label, fn] of regs) {
    try {
      ;(ctx.effect as any)(fn, `${PKG}: ${label}`)
    } catch (e) {
      console.error(`[${PKG}] slot ${label} registration failed:`, e)
    }
  }
  // 右侧栏 pane tab：类型注册 + body + title 三个 effect，key 都 = 类型 id。
  // title seat 必须注册 React 组件（照官方 FilesTitle 形状）——只有 spec 无组件时
  // seat 命中 entry 但渲染为空 → chip 无标题（0.4.3 修复）。
  // title 组件直接渲染常量、不读 tab.title——那是 tab 打开时捕获并随会话持久化的值，
  // 旧版本打开过的会话会永远带旧名（0.4.5 修复）。
  try {
    const tabsSvc = (ctx as any).sidebarRightTabs as SidebarTabsService | undefined
    if (tabsSvc) {
      ;(ctx.effect as any)(() => tabsSvc.register({
        id: `${PKG}:panel`,
        kind: `${PKG}-panel`,
        priority: 'extension',
        title: () => TITLE,
        guide: [{
          id: 'gate',
          order: 60,
          title: () => TITLE,
          description: () => '管控 skill 与 MCP 工具的可用性（Skill 全局生效，MCP 支持会话级）',
        }],
      }), `${PKG}: sidebar tab type`)
      ;(ctx.effect as any)(() => {
        slots.inject('sidebar.right.pane.tab', () =>
          slots.register({
            name: 'sidebar.right.pane.tab',
            key: `${PKG}:panel`,
          }, function GateSideBody(props: any): any {
            // props.sessionId 由 seat 渲染系统注入（官方 FilesBody 同款）；useTabInfo 兜底。
            // useTabInfo 是 hook：存在则始终调用一次，保持调用顺序稳定。
            let info: any = null
            if (typeof props?.useTabInfo === 'function') {
              try { info = props.useTabInfo() } catch { info = null }
            }
            const sessionId = String(props?.sessionId ?? info?.tab?.sessionId ?? info?.sessionId ?? '')
            return h(GatePanel, { sessionId, globalMode: false })
          }))
      }, `${PKG}: sidebar pane body`)
      ;(ctx.effect as any)(() => {
        slots.inject('sidebar.right.pane.tab.title', () =>
          slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: `${PKG}:panel`,
          }, function GateSideTitle(): any {
            return h('span', null, TITLE)
          }))
      }, `${PKG}: sidebar pane title`)
    }
  } catch (e) {
    console.warn(`[${PKG}] sidebar registration failed (non-fatal):`, e)
  }

  console.info(`[${PKG}] client applied OK (classic react)`)
}
