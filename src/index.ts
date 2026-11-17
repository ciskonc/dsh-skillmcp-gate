/**
 * dsh-skillmcp-gate — host 侧（skillmcp-gate M3）。
 * 按会话管控 skill / MCP 工具暴露集：
 *  - 工具：agent.ctx.tools.restrict({deny})（官方 scoped seam，下一条消息生效）
 *  - 技能：agent.ctx.skills.register(stub)（同名就近覆盖，目录描述变为"已禁用"）
 *  - 持久化：~/.dsh/storages/skillmcp-gate.json（global + sessions delta，覆盖写）
 *  - 重放：agent/created 时自动重挂该会话清单；POST apply 手动重放
 *  - API：/skillmcp-gate/api/state | /set | /apply（client UI 消费）
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

type ToolSchema = { name: string; description?: string }
type ScopedTools = ToolsService & { restrict(opts: { allow?: string[]; deny?: string[] }): (() => void) | void }
type ScopedSkills = SkillsService & { register(skill: unknown): (() => void) | void }
type Agent = { ctx: { tools: ScopedTools; skills: ScopedSkills } & Context; scope?: unknown; sessionId?: string }
type AgentsService = {
  get(id: string): Agent | undefined
  list(): Agent[]
}
type SkillsService = {
  register(skill: unknown): (() => void) | void
  snapshot(options?: { cwd?: string; scope?: unknown }): Promise<{ skills: Array<{ name: string; description?: string }>; complete: boolean }>
}
type ToolsService = {
  schemas(scope?: unknown): ToolSchema[]
}
type WebServerService = {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: any, res: any) => Promise<void> | void }): () => void
}

type WorkingDirectoryService = {
  get(session?: unknown): string | null | undefined
}
type AppContext = Context & {
  tools: ToolsService
  skills: SkillsService
  agents: AgentsService
  webServer: WebServerService
  workingDirectory?: WorkingDirectoryService
}

type DenialSet = { deniedTools: string[]; deniedSkills: string[] }
type Store = { global: DenialSet; sessions: Record<string, DenialSet> }

const SHORT = 'skillmcp-gate'
const API_PREFIX = '/skillmcp-gate/api'
const MCP_RE = /^mcp__([A-Za-z0-9_-]+)__(.+)$/
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

export const name = 'dsh-skillmcp-gate'
export const inject = ['tools', 'skills', 'agents', 'webServer', 'workingDirectory']

export interface Config {
  storeFile: string
}

export const Config = z.object({
  storeFile: z.string().default(''),
})

// ── 存储层（V1：JSON 覆盖写；迁移 storageDomain 留 M5）──────────────

function normalizeSessions(raw: Record<string, DenialSet>): Record<string, DenialSet> {
  // 键统一为裸 uuid：旧数据可能带 session- 前缀（/state 旧版未 normSid 时期写入），
  // 同一会话双键会造成 UI 读旧键写新键的读写分裂 → 合并去重
  const out: Record<string, DenialSet> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = String(k).replace(/^session-/, '')
    const cur = out[key] ?? { deniedTools: [], deniedSkills: [] }
    out[key] = {
      deniedTools: [...new Set([...cur.deniedTools, ...(v?.deniedTools ?? [])])].sort(),
      deniedSkills: [...new Set([...cur.deniedSkills, ...(v?.deniedSkills ?? [])])].sort(),
    }
  }
  return out
}

function loadStore(file: string): Store {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Store>
    return {
      global: { deniedTools: raw.global?.deniedTools ?? [], deniedSkills: raw.global?.deniedSkills ?? [] },
      sessions: normalizeSessions(raw.sessions ?? {}),
    }
  } catch {
    return { global: { deniedTools: [], deniedSkills: [] }, sessions: {} }
  }
}

function saveStore(file: string, store: Store): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
}

function normalizeSet(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((v): v is string => typeof v === 'string' && v.length > 0))].sort()
}

// ── 技能磁盘扫描兜底（provider 对无 scope 调用可能不扫文件系统根）──

function parseFrontmatterName(text: string, fallback: string): { name: string; description: string } {
  const m = FRONTMATTER_RE.exec(text)
  if (m) {
    const nameM = /^name:\s*(.+)$/m.exec(m[1])
    const descM = /^description:\s*(.+)$/m.exec(m[1])
    const clean = (v: string | undefined): string => (v ?? '').trim().replace(/^["']|["']$/g, '')
    return {
      name: clean(nameM?.[1]) || fallback,
      description: clean(descM?.[1]).slice(0, 200),
    }
  }
  return { name: fallback, description: '' }
}

function scanSkillDirs(workspace: string, dshHome: string): Array<{ name: string; description: string; source: string }> {
  const roots: Array<[string, string]> = [
    [join(workspace, '.dsh', 'skills'), 'project-dsh'],
    [join(workspace, '.agents', 'skills'), 'project-agents'],
    [join(dshHome, 'skills'), 'user-dsh'],
    [join(homedir(), '.agents', 'skills'), 'user-agents'],
  ]
  const out = new Map<string, { name: string; description: string; source: string }>()
  for (const [dir, source] of roots) {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      try {
        const full = join(dir, entry)
        const stat = statSync(full)
        let text = ''
        let name = entry.replace(/\.md$/, '')
        if (stat.isDirectory()) {
          text = readFileSync(join(full, 'SKILL.md'), 'utf8')
        } else if (entry.endsWith('.md')) {
          text = readFileSync(full, 'utf8')
        } else continue
        const parsed = parseFrontmatterName(text, name)
        if (!out.has(parsed.name)) out.set(parsed.name, { name: parsed.name, description: parsed.description, source })
      } catch { /* 单个坏条目不阻断 */ }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── apply(ctx, config) ──────────────────────────────────────────────

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const storeFile = config.storeFile || join(dshHome, 'storages', SHORT + '.json')
  let store = loadStore(storeFile)
  /** sessionId → 当前挂载的 disposer（重放前先拆旧） */
  const applied = new Map<string, { disposers: Array<() => void>; key: string }>()
  /** registry 键是 session-<uuid>，store 键是裸 uuid——统一规范化 */
  const normSid = (id: string): string => id.replace(/^session-/, '')

  const traceFile = join(dirname(storeFile), SHORT + '.trace.log')
  const trace = (msg: string): void => {
    try { mkdirSync(dirname(traceFile), { recursive: true }); appendFileSync(traceFile, '[' + new Date().toISOString() + '] ' + msg + '\n') } catch { /* ignore */ }
  }

  /** 全局 skill 禁用的 stub disposer（内存态，重启重放） */
  const globalSkillDisposers: Array<() => void> = []

  const persist = (): void => {
    try { saveStore(storeFile, store) } catch (e) { ctx.logger?.warn?.(`[${SHORT}] store save failed: ${e}`) }
  }

  const effective = (sessionId: string | null): DenialSet => {
    const g = store.global
    const s = sessionId ? store.sessions[sessionId] : undefined
    return {
      deniedTools: [...new Set([...g.deniedTools, ...(s?.deniedTools ?? [])])].sort(),
      deniedSkills: [...new Set([...g.deniedSkills, ...(s?.deniedSkills ?? [])])].sort(),
    }
  }

  const liveAgent = (sessionId: string): Agent | undefined => {
    try { return ctx.agents.get(sessionId) } catch { return undefined }
  }

  /** 对单个会话挂 enforcement（幂等：先拆旧再挂新）。 */
  const applyToSession = (sessionId: string): { ok: boolean; reason?: string; deniedTools: number; deniedSkills: number } => {
    trace(`applyToSession(${sessionId}) begin`)
    const prev = applied.get(sessionId)
    if (prev) {
      for (const d of prev.disposers) { try { d() } catch { /* scope 已销毁 */ } }
      applied.delete(sessionId)
    }
    const agent = liveAgent(sessionId)
    if (!agent) { trace(`applyToSession(${sessionId}) no-live-agent`); return { ok: false, reason: 'no-live-agent', deniedTools: 0, deniedSkills: 0 } }
    const want = effective(sessionId)
    const disposers: Array<() => void> = []
    let deniedTools = 0
    let deniedSkills = 0
    // 1) 工具 deny：只 deny 当前真实存在的名字（restrict 对未知名 throw）
    try {
      const existing = new Set<string>(ctx.tools.schemas().map((t) => t.name))
      const deny = want.deniedTools.filter((n) => existing.has(n))
      deniedTools = deny.length
      if (deny.length > 0) {
        const d = agent.ctx.tools.restrict({ deny })
        if (typeof d === 'function') disposers.push(d)
      }
    } catch (e) {
      ctx.logger?.warn?.(`[${SHORT}] tool restrict failed for ${sessionId}: ${e}`)
    }
    // 2) 技能 stub 覆盖：同名就近覆盖（registry 层链 Map.set 语义），目录描述变为"已禁用"
    for (const skillName of want.deniedSkills) {
      try {
        const d = agent.ctx.skills.register({
          name: skillName,
          description: '[disabled] 该 Skill 已被用户禁用（skillmcp-gate）',
          body: `# ${skillName}（disabled）\n\n该 Skill 已被用户禁用。不要尝试使用它；如任务需要该能力，请如实告知用户。`,
        } as any)
        if (typeof d === 'function') disposers.push(d)
        deniedSkills += 1
      } catch (e) {
        ctx.logger?.warn?.(`[${SHORT}] skill stub failed for ${skillName}@${sessionId}: ${e}`)
      }
    }
    applied.set(sessionId, { disposers, key: want.deniedTools.join(',') + '|' + want.deniedSkills.join(',') })
    trace(`applyToSession(${sessionId}) applied tools=${deniedTools} skills=${deniedSkills}`)
    return { ok: true, deniedTools, deniedSkills }
  }

  const applyAllLive = (): void => {
    try {
      for (const agent of ctx.agents.list()) {
        const sid = String((agent as any).sessionId ?? '')
        if (sid && (store.sessions[sid] || store.global.deniedTools.length || store.global.deniedSkills.length)) {
          applyToSession(sid)
        }
      }
    } catch { /* agents 服务不可用时静默 */ }
  }

  // 会话创建/恢复 → 自动重放该会话（或全局）清单（D7）。
  // agent/created 在 agent 自身 carrier 上派发（ctx.serial），根层监听不可靠——
  // 改为包装 ctx.agents.get/list：循环首次取到 agent 时就地挂 restrict
  // （loop 处理 inbox 先 get 再 preStep 组装，时机正好"下一条消息生效"）。
  const ensureApplied = (agent: Agent, rawSid: string): void => {
    const sid = normSid(rawSid)
    const want = effective(sid)
    const wantKey = want.deniedTools.join(',') + '|' + want.deniedSkills.join(',')
    const prevKey = applied.get(sid)
    if (prevKey !== void 0 && prevKey.key === wantKey) return // deny 未变且已生效
    if (prevKey !== void 0) {
      // deny 变了——拆旧重挂
      for (const d of prevKey.disposers) { try { d() } catch { /* 旧 scope */ } }
      applied.delete(sid)
    }
    if (want.deniedTools.length === 0 && want.deniedSkills.length === 0) {
      applied.delete(sid)
      return
    }
    const prev = applied.get(sid)
    if (prev) for (const d of prev.disposers) { try { d() } catch { /* 旧 scope */ } }
    const disposers: Array<() => void> = []
    let deniedTools = 0
    try {
      // 直接 restrict 完整 deny 列表；schemas() 只见根层（27 个）不能当完整视图，
      // 若 restrict 对未知名 throw 则逐名降级重试
      deniedTools = want.deniedTools.length
      try {
        const d = agent.ctx.tools.restrict({ deny: want.deniedTools })
        if (typeof d === 'function') disposers.push(d)
        trace(`restrict ok (${want.deniedTools.length})`)
      } catch (batchErr) {
        trace(`restrict batch threw: ${batchErr}; falling back per-name`)
        for (const n of want.deniedTools) {
          try {
            const d = agent.ctx.tools.restrict({ deny: [n] })
            if (typeof d === 'function') disposers.push(d)
            deniedTools += 1
          } catch (e) {
            trace(`restrict name ${n} threw: ${e}`)
          }
        }
      }
    } catch (e) {
      trace(`restrict failed for ${sid}: ${e}`)
    }
    for (const skillName of want.deniedSkills) {
      try {
        const sd = agent.ctx.skills.register({
          name: skillName,
          description: '[disabled] 该 Skill 已被用户禁用（skillmcp-gate）',
          body: `# ${skillName}（disabled）\n\n该 Skill 已被用户禁用。不要尝试使用它；如任务需要该能力，请如实告知用户。`,
        } as any)
        if (typeof sd === 'function') disposers.push(sd)
      } catch { /* stub 失败不阻断 */ }
    }
    applied.set(sid, { disposers, key: wantKey })
    trace(`ensureApplied(${sid}) tools=${deniedTools} skills=${want.deniedSkills.length}`)
  }

  try {
    const agentsSvc = ctx.agents as unknown as { get(id: string): Agent | undefined; list(): Agent[] }
    const origGet = agentsSvc.get.bind(agentsSvc)
    const origList = agentsSvc.list.bind(agentsSvc)
    agentsSvc.get = (id: string): Agent | undefined => {
      const a = origGet(id)
      if (a) { try { ensureApplied(a, id) } catch (e) { trace(`ensureApplied failed for ${id}: ${e}`) } }
      return a
    }
    agentsSvc.list = (): Agent[] => {
      const all = origList()
      for (const a of all) {
        const sid = String((a as any).id ?? '')
        if (sid) { try { ensureApplied(a, sid) } catch { /* ignore */ } }
      }
      return all
    }
    trace('agents.get/list wrapped (lazy enforcement active)')
    // 周期 sweep：覆盖 loop 内部持有引用/恢复自磁盘的 agent（不走 get() 的路径）。
    // list() 已被包装——内部即 ensureApplied 全部 live agent。
    ctx.effect(() => {
      const t = setInterval(() => { try { agentsSvc.list() } catch { /* ignore */ } }, 2000)
      try { agentsSvc.list() } catch { /* ignore */ }
      return (): void => clearInterval(t)
    }, 'skillmcp-gate: sweep')
  } catch (e) {
    trace(`agents wrap failed: ${e}`)
  }

  // 诊断探针：确定 agent/created 参数形状与根层可达性
  // agent/created 信封 = { agent, source, signal }（根层可达，agent 存活期内 restrict 持续生效）
  ;(ctx as any).on('agent/created', (envelope: any) => {
    try {
      const agent = envelope?.agent
      const sid = String(agent?.id ?? agent?.session?.id ?? '')
      trace(`agent/created sid=${sid}`)
      if (sid) ensureApplied(agent, sid)
    } catch (e) { trace(`agent/created handler failed: ${e}`) }
  })

  // 兜底：事件若可达仍挂一份（部分宿主版本事件在根层可见）
  ;(ctx as any).on('agent/created', (agent: any) => {
    const sid = String(agent?.id ?? agent?.session?.id ?? '')
    if (sid) { try { ensureApplied(agent, sid) } catch { /* ignore */ } }
  })

  // ── HTTP API（client UI 消费；同源 fetch，无 CORS 需求）──────────

  const json = (res: any, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req: any): Promise<any> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://local')
      const route = url.pathname.slice(API_PREFIX.length) // '' | '/state' | '/set' | '/apply'
      try {
        if (req.method === 'GET' && (route === '/state' || route === '')) {
          // 与 /set 一致：registry 键带 session- 前缀、store 键是裸 uuid——读写必须同一键
          const rawSessionId = url.searchParams.get('sessionId') ?? ''
          const sessionId = rawSessionId.replace(/^session-/, '')
          let cwd = url.searchParams.get('cwd') ?? ''
          if (!cwd) {
            // 会话有效工作目录（attached 会话；fallback 进程 cwd）
            try { cwd = ctx.workingDirectory?.get?.(rawSessionId) ?? ctx.workingDirectory?.get?.(sessionId) ?? process.cwd() } catch { cwd = process.cwd() }
          }
          if (!cwd) cwd = process.cwd()
          // 工具清单：mcp__server__tool 分组；其余 builtin（V1 不管控，仅展示）
          const tools = ctx.tools.schemas().map((t) => {
            const m = MCP_RE.exec(t.name)
            return m
              ? { name: t.name, kind: 'mcp' as const, server: m[1], tool: m[2], description: t.description ?? '' }
              : { name: t.name, kind: 'builtin' as const, server: '', tool: t.name, description: t.description ?? '' }
          }).sort((a, b) => (a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server)))
          // 技能清单：provider snapshot + 磁盘扫描兜底合并
          let skills: Array<{ name: string; description?: string }> = []
          let skillsComplete = true
          try {
            const snap = await ctx.skills.snapshot({ cwd })
            const seen = new Set<string>()
            for (const sk of snap.skills) { seen.add(sk.name); skills.push({ name: sk.name, description: sk.description }) }
            for (const dsk of scanSkillDirs(cwd, dshHome)) {
              if (!seen.has(dsk.name)) skills.push({ name: dsk.name, description: dsk.description })
            }
            skillsComplete = snap.complete
          } catch (e) {
            skills = scanSkillDirs(cwd, dshHome)
            skillsComplete = false
            ctx.logger?.warn?.(`[${SHORT}] skills snapshot failed (disk fallback): ${e}`)
          }
          skills.sort((a, b) => a.name.localeCompare(b.name))
          const mcpServers = [...new Set(tools.filter((t) => t.kind === 'mcp').map((t) => t.server!))]
          const session = store.sessions[sessionId] ?? null
          return json(res, 200, {
            sessionId,
            cwd,
            tools,
            skills,
            skillsComplete,
            mcpServers,
            global: store.global,
            session,
            applied: sessionId ? (applied.get(normSid(sessionId)) ?? null) : null,
            agentLive: sessionId ? !!liveAgent(sessionId) : false,
            sessionsIndex: Object.fromEntries(
              Object.entries(store.sessions).map(([k, v]) => [k, { tools: v.deniedTools.length, skills: v.deniedSkills.length }]),
            ),
          })
        }
        if (req.method === 'POST' && route === '/set') {
          const body = await readBody(req)
          const scope = body.scope === 'global' ? 'global' : body.scope === 'skill-global' ? 'skill-global' : 'session'
          // client 的 sessionId 可能带 session- 前缀（registry 键形态）——统一规范化
          const sessionId = String(body.sessionId ?? '').replace(/^session-/, '')
          const patch: DenialSet = {
            deniedTools: normalizeSet(body.deniedTools),
            deniedSkills: normalizeSet(body.deniedSkills),
          }
          if (scope === 'global') {
            store.global = patch
          } else {
            if (!sessionId) return json(res, 400, { error: 'sessionId required for session scope' })
            // 空 delta = 回归继承 → 删除会话条目
            if (patch.deniedTools.length === 0 && patch.deniedSkills.length === 0) delete store.sessions[sessionId]
            else store.sessions[sessionId] = patch
          }
          persist()
          // 立即作用于该会话（若 live）；global 作用于全部 live 会话
          if (scope === 'skill-global') {
            for (const d of globalSkillDisposers) { try { d() } catch { /* ignore */ } }
            globalSkillDisposers.length = 0
            store.global.deniedSkills = patch.deniedSkills
            persist()
            for (const skillName of patch.deniedSkills) {
              try {
                const d = ctx.skills.register({
                  name: skillName,
                  description: '[disabled] 该 Skill 已被用户全局禁用（skillmcp-gate）',
                  body: `# ${skillName}（disabled）\n\n该 Skill 已被用户全局禁用。不要尝试使用它；如任务需要该能力，请如实告知用户。`,
                } as any)
                if (typeof d === 'function') globalSkillDisposers.push(d)
              } catch (e) {
                ctx.logger?.warn?.(`[${SHORT}] global skill stub failed for ${skillName}: ${e}`)
              }
            }
            return json(res, 200, { ok: true, applied: 'global-skills', count: patch.deniedSkills.length })
          }
          if (scope === 'session' && sessionId) {
            // skill 管控走全局（per-session 覆盖受 DSH 架构限制）
            for (const d of globalSkillDisposers) { try { d() } catch { /* ignore */ } }
            globalSkillDisposers.length = 0
            store.global.deniedSkills = patch.deniedSkills
            for (const skillName of patch.deniedSkills) {
              try {
                const sd = ctx.skills.register({
                  name: skillName,
                  description: '[disabled] 该 Skill 已被用户禁用（skillmcp-gate）',
                  body: `# ${skillName}（disabled）\n\n该 Skill 已被用户禁用。不要尝试使用它。`,
                } as any)
                if (typeof sd === 'function') globalSkillDisposers.push(sd)
              } catch { /* ignore */ }
            }
            const r = applyToSession(sessionId)
            return json(res, 200, { ok: true, applied: r, globalSkills: patch.deniedSkills.length })
          }
          applyAllLive()
          return json(res, 200, { ok: true, applied: 'all-live' })
        }
        if (req.method === 'POST' && route === '/apply') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (!sessionId) return json(res, 400, { error: 'sessionId required' })
          return json(res, 200, { ok: true, applied: applyToSession(sessionId) })
        }
        return json(res, 404, { error: `unknown route ${req.method} ${route}` })
      } catch (e: any) {
        ctx.logger?.warn?.(`[${SHORT}] api error: ${e?.stack ?? e}`)
        return json(res, 500, { error: String(e?.message ?? e) })
      }
    },
  }), `${SHORT}: api`)

  // 重放全局 skill deny（重启后 stub 消失需重挂）
  if (store.global.deniedSkills.length > 0) {
    for (const skillName of store.global.deniedSkills) {
      try {
        const d = ctx.skills.register({
          name: skillName,
          description: '[disabled] 该 Skill 已被用户全局禁用（skillmcp-gate）',
          body: `# ${skillName}（已禁用）\n\n该技能已被用户全局禁用。不要尝试使用它；如任务需要该能力，请如实告知用户。`,
        } as any)
        if (typeof d === 'function') globalSkillDisposers.push(d)
      } catch { /* ignore */ }
    }
  }

  // ── hook skills.snapshot：per-session 过滤被禁 skill ──────────────
  // skills.register 写 global 层无法 per-session；改为 monkey-patch snapshot
  // 在返回前按 scope 的 sessionId 过滤掉被禁 skill → catalog digest 变化 → 模型看到新列表
  try {
    const skillsAny = ctx.skills as any
    const origSnapshot = skillsAny.snapshot.bind(skillsAny)
    skillsAny.snapshot = async (options: any) => {
      const result = await origSnapshot(options)
      const rawSid = String(options?.scope?.id ?? options?.scope?.session?.id ?? '')
      const sid = normSid(rawSid)
      if (!sid) return result
      const denied = effective(sid)
      if (denied.deniedSkills.length === 0) return result
      const filtered = {
        ...result,
        skills: result.skills.filter((s: any) => !denied.deniedSkills.includes(s.name)),
      }
      trace(`snapshot filtered for ${sid}: ${result.skills.length} -> ${filtered.skills.length}`)
      return filtered
    }
    trace('skills.snapshot patched for per-session filtering')
  } catch (e) {
    trace(`skills snapshot patch failed: ${e}`)
  }

  ctx.logger?.info?.(`[${SHORT}] ready — store=${storeFile}`)
}
