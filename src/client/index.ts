/**
 * dsh-skillmcp-gate — client 侧（0.4.2）。
 * 0.4.2 变更：
 *  - 命名统一「Skill & MCP」；正文术语 skill 保留英文不译中文
 *  - 修复右侧栏 tab：title slot 补 React 组件（照官方 FilesTitle 形状，useTabInfo 取 tab.title）；
 *    body 组件 sessionId 取 props.sessionId，useTabInfo 兜底
 *  - Skill 分组下方常驻「全局生效」提示；删除底部内置工具行与 [debug] 行
 *  - debug 信息移至设置页（store 概要）
 *  - banner（conversation.view）默认不注册；设置页开关（localStorage）控制，切换后刷新生效
 * 不用 JSX：全部 React.createElement（classic runtime），与生态一致——
 * 宿主 ModuleLoader 的 require 映射对 react 可解析，对 react/jsx-runtime 未验证。
 */
import type { Context } from '@deepseek-ai/cordis'
import React, { useState, useEffect, useCallback } from 'react'

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
/** banner 入口显示开关的 localStorage 键（默认关：右侧栏为默认入口） */
const BANNER_KEY = 'skillmcp-gate:banner-visible'
const h = React.createElement

type ToolRow = { name: string; kind: 'mcp' | 'builtin'; server: string; tool: string; description?: string }
type SkillRow = { name: string; description?: string }
type State = {
  sessionId: string
  cwd?: string
  tools: ToolRow[]
  skills: SkillRow[]
  mcpServers: string[]
  global: { deniedTools: string[]; deniedSkills: string[] }
  session: { deniedTools: string[]; deniedSkills: string[] } | null
  applied: { deniedTools?: number; deniedSkills?: number } | null
  agentLive: boolean
  sessionsIndex?: Record<string, { tools: number; skills: number }>
}

async function apiGet(query: string): Promise<State> {
  const res = await fetch(`${API}/state${query}`)
  if (!res.ok) throw new Error(`state ${res.status}`)
  return res.json()
}

async function apiSet(body: any): Promise<void> {
  const res = await fetch(`${API}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`set ${res.status}`)
}

function bannerEnabled(): boolean {
  try { return window.localStorage.getItem(BANNER_KEY) === '1' } catch { return false }
}

// ── React 面板 ──────────────────────────────────────────────────────

function GatePanel(props: { sessionId?: string; globalMode?: boolean }): React.ReactElement {
  const { sessionId, globalMode = false } = props
  const [st, setSt] = useState<State | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** 草稿：勾选只改本地，点"应用"才批量提交（减少缓存失效次数） */
  const [draft, setDraft] = useState<{ t: Set<string>; s: Set<string> } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setErr(null)
      setSt(await apiGet(`?sessionId=${encodeURIComponent(sessionId ?? '')}`))
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    }
  }, [sessionId])

  useEffect(() => { void load() }, [load])

  const applyDraft = useCallback(async (): Promise<void> => {
    if (!draft) return
    try {
      setErr(null)
      const body = globalMode
        ? { scope: 'global', deniedTools: [...draft.t], deniedSkills: [...draft.s] }
        : { scope: 'session', sessionId, deniedTools: [...draft.t], deniedSkills: [...draft.s] }
      await apiSet(body)
      setDraft(null)
      await load()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    }
  }, [draft, globalMode, sessionId, load])

  if (err !== null) {
    return h('div', { style: { padding: 10, color: '#f66' } }, `加载失败：${err}`)
  }
  if (st === null) {
    return h('div', { style: { padding: 10, opacity: 0.6 } }, '加载中…')
  }

  const appliedT = new Set(st.global.deniedTools)
  const appliedS = new Set(st.global.deniedSkills)
  if (!globalMode && st.session) {
    for (const x of st.session.deniedTools) appliedT.add(x)
    for (const x of st.session.deniedSkills) appliedS.add(x)
  }
  // 渲染视图：有 draft 时勾选框/删除线/计数立即反映用户选择（生效仍等「批量应用」）
  const deniedT = draft !== null ? draft.t : appliedT
  const deniedS = draft !== null ? draft.s : appliedS
  const setTool = (name: string, denied: boolean): void => {
    const base = draft ?? { t: new Set(deniedT), s: new Set(deniedS) }
    const next = new Set(base.t)
    if (denied) next.add(name)
    else next.delete(name)
    setDraft({ t: next, s: new Set(base.s) })
  }
  const setSkill = (name: string, denied: boolean): void => {
    const base = draft ?? { t: new Set(deniedT), s: new Set(deniedS) }
    const next = new Set(base.s)
    if (denied) next.add(name)
    else next.delete(name)
    setDraft({ t: new Set(base.t), s: next })
  }
  const setServer = (server: string, denyAll: boolean): void => {
    const base = draft ?? { t: new Set(deniedT), s: new Set(deniedS) }
    const next = new Set(base.t)
    for (const t of st.tools.filter((x) => x.kind === 'mcp' && x.server === server)) {
      if (denyAll) next.add(t.name)
      else next.delete(t.name)
    }
    setDraft({ t: next, s: new Set(base.s) })
  }

  const mcpRows = st.tools.filter((t) => t.kind === 'mcp')
  const mcpTotal = mcpRows.length
  const skillAvailable = st.skills.length - deniedS.size
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }
  const groupStyle = { margin: '8px 0', border: '1px solid rgba(127,127,127,.25)', borderRadius: 6, padding: '6px 8px' }

  const serverGroups = st.mcpServers.map((server: string) => {
    const serverTools = mcpRows.filter((t) => t.server === server)
    const deniedCount = serverTools.filter((t) => deniedT.has(t.name)).length
    const allDenied = deniedCount === serverTools.length
    const toolRows = serverTools.map((t: ToolRow) =>
      h('label', { key: t.name, style: rowStyle, title: t.description?.slice(0, 160) },
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
        h('span', null, `MCP · ${server}（${serverTools.length - deniedCount}/${serverTools.length} 可用）`),
      ),
      h('div', { style: { margin: '2px 0 0 18px' } }, toolRows),
    )
  })

  const skillRows = st.skills.map((sk: SkillRow) =>
    h('label', { key: sk.name, style: rowStyle, title: sk.description?.slice(0, 160) },
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

  const statusLine = globalMode
    ? draft !== null
      ? `应用后：${mcpTotal - deniedT.size}/${mcpTotal} MCP · ${skillAvailable}/${st.skills.length} Skill（全局默认）`
      : `全局默认：${mcpTotal - deniedT.size}/${mcpTotal} MCP · ${skillAvailable}/${st.skills.length} Skill（新会话继承）`
    : draft !== null
      ? `应用后：${mcpTotal - deniedT.size}/${mcpTotal} MCP（本会话）· ${skillAvailable}/${st.skills.length} Skill（全局）`
      : `下条消息生效：${mcpTotal - deniedT.size}/${mcpTotal} MCP（本会话）· ${skillAvailable}/${st.skills.length} Skill（全局）${st.agentLive ? '' : ' · 下条消息唤醒时生效'}`

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
    h('div', { style: { fontSize: 11, opacity: 0.5, marginBottom: 6 } },
      globalMode ? '全局默认（新会话继承）' : '本会话面板 · MCP 勾选只影响当前会话'),
    h('div', { style: { padding: '6px 8px', marginBottom: 8, borderRadius: 6, background: 'rgba(127,127,127,.15)' } },
      statusLine),
    draft !== null && h('div', {
      style: {
        padding: '6px 8px', marginBottom: 8, borderRadius: 6,
        background: 'rgba(255,180,0,.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      },
    },
      h('span', null, `⚠ ${draft.t.size + draft.s.size} 项变更待应用`),
      h('button', {
        onClick: () => void applyDraft(),
        style: {
          padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
          background: '#4a9eff', color: '#fff', fontSize: 11,
        },
      }, '批量应用'),
    ),
    ...serverGroups,
    h('div', { style: groupStyle },
      h('div', { style: { fontWeight: 600, margin: '2px 0' } },
        `Skill（${skillAvailable}/${st.skills.length} 可用）`),
      ...skillRows,
      h('div', {
        style: {
          marginTop: 6, padding: '4px 6px', borderRadius: 4,
          background: 'rgba(255,180,0,.15)', fontSize: 11,
        },
      }, '⚠ Skill 开关为全局生效：影响所有会话（暂不支持单会话级管控）'),
    ),
    globalMode && h('div', { style: { margin: '8px 0' } },
      h('label', { style: rowStyle, title: '开启后会在会话顶部显示 Skill & MCP 入口；右侧栏始终可用' },
        h('input', {
          type: 'checkbox',
          checked: bannerEnabled(),
          onChange: (e: any) => {
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
      // 官方形状（照 ui-trajectory）：inject factory 返回 register(spec, React组件)；
      // spec.inject(sessionId) 注入数据；component 是 register 第二参数。
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
      console.error(`[skillmcp-gate] slot ${label} registration failed:`, e)
    }
  }
  // 3) 右侧栏 pane tab（D8）：类型注册 + body + title 三个 effect，key 都 = 类型 id。
  //    0.4.2 修复：title seat 必须注册 React 组件（照官方 FilesTitle）——
  //    只有 spec 无组件时 seat 命中 entry 但渲染为空 → chip 无标题。
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
            // 不读 tab.title：那是 tab 打开时捕获并随会话持久化的值，
            // 旧版本（暴露管控时代）打开过的会话会永远带着旧名——直接用当前常量
            return h('span', null, TITLE)
          }))
      }, `${PKG}: sidebar pane title`)
    }
  } catch (e) {
    console.warn('[skillmcp-gate] sidebar registration failed (non-fatal):', e)
  }

  console.info('[skillmcp-gate] client applied OK (classic react)')
}
