/**
 * dsh-skillmcp-gate — host 侧（0.5.1 对抗审查修复版）。
 * 按会话管控 skill / MCP 工具暴露集：
 *  - 工具：agent.ctx.tools.restrict({deny})（官方 scoped seam，下一条消息生效）
 *  - 技能：agent.ctx.skills.register(stub)（注意：0.2.2-rc.5 是 first-wins 非「覆盖」，
 *    且 project 来源 rank 低于 runtime 层——project 级 skill 的 stub 方案无效，
 *    生效通道是 skills.snapshot patch 过滤；stub 仅作 user/custom 来源的辅助层。迁移 SkillProvider 见 V2）
 *  - 持久化：~/.dsh/storages/skillmcp-gate.json（原子写 tmp+rename；读失败分级处理）
 *  - 重放：agents.get/list 包装懒执行 + 2s sweep（partial 永不短路，失败自动重试）
 *
 * ── 命名三分法（不可改契约，改动前必读）────────────────────────
 *  - 包名 dsh-skillmcp-gate：可改（需同步 package.json/host name/client PKG/tsdown PLUGIN_ID/cordis.patch.yml 五处）
 *  - 短名 skillmcp-gate：永久内部标识，永不随包名改——API 路由、store/trace 文件名、
 *    localStorage key（client）、cordis.patch.yml 的 id
 *  - slot key（client `${PKG}:panel`）：随包名改 = BREAKING（会话持久化旧 tab 失效）
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, appendFileSync, statSync as stat } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

type ToolSchema = { name: string; description?: string }
type ScopedTools = ToolsService & { restrict(opts: { allow?: string[]; deny?: string[] }): (() => void) | void }
type ScopedSkills = SkillsService & { register(skill: unknown): (() => void) | void }
type Agent = { ctx: { tools: ScopedTools; skills: ScopedSkills } & Context; scope?: unknown }
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

const SHORT = 'skillmcp-gate' // 永久内部标识（见文件头命名三分法），禁止改为包名
const API_PREFIX = '/skillmcp-gate/api'
/** 贪心版：取最后一个 __ 作 server/tool 分隔；兼容含点/非 ASCII 的 server 名（0.5.1 放宽） */
const MCP_RE = /^mcp__(.+)__(.+)$/
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
/** normalizeSet 上限：防超长列表原样落盘并传宿主（0.5.1） */
const DENY_MAX_ITEMS = 1000
const DENY_MAX_NAME_LEN = 256
/** trace.log 轮转阈值 */
const TRACE_MAX_BYTES = 512 * 1024

export const name = 'dsh-skillmcp-gate'
// workingDirectory 不强制声明（0.5.1：可选服务缺失时避免 cordis park 整个插件；
// 代码本就按可选用 ?. 防御），运行时经 ctx 取
export const inject = ['tools', 'skills', 'agents', 'webServer']

export interface Config {
  storeFile: string
}

export const Config = z.object({
  storeFile: z.string().default(''),
})

// ── 存储层（0.5.1：原子写 tmp+rename；读取分级 ENOENT/损坏）────────

function normalizeSet(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const cleaned = [...new Set(list.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= DENY_MAX_NAME_LEN))].sort()
  return cleaned.slice(0, DENY_MAX_ITEMS)
}

function normalizeSessions(raw: Record<string, DenialSet>): Record<string, DenialSet> {
  // 键统一为裸 uuid（循环剥前缀防 session-session- 双前缀残留），元素过 normalizeSet 清洗
  const out: Record<string, DenialSet> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    let key = String(k)
    while (key.startsWith('session-')) key = key.slice('session-'.length)
    if (!key) continue
    // 0.5.2 修复 W5：空/非法条目不建幽灵键（sessionsIndex 不再显示 0/0 残留）
    const tools = normalizeSet(v?.deniedTools)
    const skills = normalizeSet(v?.deniedSkills)
    if (tools.length === 0 && skills.length === 0) continue
    const cur = out[key] ?? { deniedTools: [], deniedSkills: [] }
    out[key] = {
      deniedTools: [...new Set([...cur.deniedTools, ...tools])].sort(),
      deniedSkills: [...new Set([...cur.deniedSkills, ...skills])].sort(),
    }
  }
  return out
}

function normalizeStore(raw: Partial<Store>): Store {
  return {
    global: { deniedTools: normalizeSet(raw.global?.deniedTools), deniedSkills: normalizeSet(raw.global?.deniedSkills) },
    sessions: normalizeSessions(raw.sessions ?? {}),
  }
}

const EMPTY_STORE: Store = { global: { deniedTools: [], deniedSkills: [] }, sessions: {} }

/**
 * 读 store。返回 corrupted=true 表示「文件存在但损坏/不可读」——
 * 调用方必须隔离现场（改名保留）并告警，禁止用空 store 静默覆盖（0.5.1 修复 H-1）。
 * ENOENT（首次运行）返回 corrupted=false。
 */
function loadStore(file: string): { store: Store; corrupted: boolean } {
  let rawText: string
  try {
    rawText = readFileSync(file, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { store: EMPTY_STORE, corrupted: false }
    return { store: EMPTY_STORE, corrupted: true } // 存在但不可读（权限/占用）
  }
  try {
    const parsed = JSON.parse(rawText) as unknown
    // 0.5.2 修复 W2：错形 JSON（顶层非对象）与半写损坏同 threat——静默归空会在下次 /set
    // 覆盖原文件且无备份，一律走 corrupted 隔离保留现场
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Partial<Store>).global === null) {
      return { store: EMPTY_STORE, corrupted: true }
    }
    return { store: normalizeStore(parsed as Partial<Store>), corrupted: false }
  } catch {
    return { store: EMPTY_STORE, corrupted: true } // JSON 损坏（半写等）
  }
}

/** 原子写：先写同目录 tmp，再 rename 替换（0.5.1 修复 H-1 半写损坏） */
function saveStore(file: string, store: Store): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, file)
}

// ── 技能磁盘扫描兜底（provider 对无 scope 调用可能不扫文件系统根）──

function parseFrontmatterName(text: string, fallback: string): { name: string; description: string } {
  // 0.5.1：剥 UTF-8 BOM（Windows 编辑器常见），否则 ^--- 锚失效 → 文件名兜底 → 假禁用
  const clean0 = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const m = FRONTMATTER_RE.exec(clean0)
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
    // 仅真实用户主目录（.agents 不跟随 DSH_HOME——设计取舍：这是跨实例共享的用户级目录）
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
        let name = entry.replace(/\.md$/i, '')
        if (stat.isDirectory()) {
          text = readFileSync(join(full, 'SKILL.md'), 'utf8')
        } else if (entry.toLowerCase().endsWith('.md')) {
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

  const traceFile = join(dirname(storeFile), SHORT + '.trace.log')
  const trace = (msg: string): void => {
    try {
      mkdirSync(dirname(traceFile), { recursive: true })
      try { if (stat(traceFile).size > TRACE_MAX_BYTES) renameSync(traceFile, traceFile.replace(/\.log$/, '.old.log')) } catch { /* 首次不存在 */ }
      appendFileSync(traceFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* ignore */ }
  }

  // 读 store（分级）：损坏/不可读 → 隔离现场改名保留 + 告警 + 禁止本进程覆盖写（0.5.1 修复 H-1）
  const loaded = loadStore(storeFile)
  const store = loaded.store
  let storeQuarantined = false
  if (loaded.corrupted) {
    storeQuarantined = true
    try {
      renameSync(storeFile, storeFile + '.corrupted-' + Date.now())
      trace('store file corrupted/unreadable — quarantined as .corrupted-*; persistence DISABLED this process')
    } catch { /* 隔离失败则 readOnly 双保险 */ }
    ctx.logger?.warn?.(`[${SHORT}] store file corrupted — quarantined as .corrupted-*; starting empty, persistence disabled this process. Restore from the quarantined file if needed.`)
  }

  /** sessionId → 当前挂载（重放前先拆旧）。partial=true 表示上次执行有失败项；
   *  failCount/lastFailAt 用于降频退避（0.5.2 修复 W6：永久失败不再每 2s 风暴重试） */
  const applied = new Map<string, { disposers: Array<() => void>; key: string; partial: boolean; failCount: number; lastFailAt: number }>()
  /** registry 键是 session-<uuid>，store 键是裸 uuid——统一规范化（单一函数，0.5.1 收敛） */
  const normSid = (id: string): string => {
    let s = String(id ?? '')
    while (s.startsWith('session-')) s = s.slice('session-'.length)
    return s
  }

  /** 全局 skill 禁用的 stub disposer（内存态，重启重放） */
  const globalSkillDisposers: Array<() => void> = []

  const persist = (): void => {
    if (storeQuarantined) { trace('persist skipped (store quarantined this process)'); return }
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

  /** 统一禁用 stub（0.5.1：单点生成，content+body 双字段——content 是 0.2.2-rc.5 正式字段名） */
  const makeDisabledStub = (skillName: string, globalScope: boolean): unknown => ({
    name: skillName,
    description: `[disabled] 该 Skill 已被用户${globalScope ? '全局' : ''}禁用（dsh-skillmcp-gate）`,
    content: `# ${skillName}（disabled）\n\n该 Skill 已被用户${globalScope ? '全局' : ''}禁用。不要尝试使用它；如任务需要该能力，请如实告知用户。`,
    body: `# ${skillName}（disabled）\n\n该 Skill 已被用户${globalScope ? '全局' : ''}禁用。不要尝试使用它；如任务需要该能力，请如实告知用户。`,
  })

  const registerGlobalSkillStubs = (names: string[]): number => {
    for (const d of globalSkillDisposers) { try { d() } catch { /* ignore */ } }
    globalSkillDisposers.length = 0
    let ok = 0
    for (const skillName of names) {
      try {
        const d = ctx.skills.register(makeDisabledStub(skillName, true) as any)
        if (typeof d === 'function') globalSkillDisposers.push(d)
        ok += 1
      } catch (e) {
        ctx.logger?.warn?.(`[${SHORT}] global skill stub failed for ${skillName}: ${e}`)
      }
    }
    return ok
  }

  // ── 统一 enforcement（0.5.1 修复 M-8 双实现分叉 / M-1 partial 永久短路）──

  const detach = (sid: string): void => {
    const prev = applied.get(sid)
    if (prev) {
      for (const d of prev.disposers) { try { d() } catch { /* scope 已销毁 */ } }
      applied.delete(sid)
    }
  }

  type EnforceResult = { attempted: number; okTools: number; okSkills: number; failedSkills: string[]; partial: boolean }

  /** 对单个 agent 挂 enforcement：先拆旧再挂新，返回精确成败（调用方决定记录策略） */
  const enforce = (agent: Agent, sid: string): EnforceResult => {
    detach(sid)
    const want = effective(sid)
    if (want.deniedTools.length === 0 && want.deniedSkills.length === 0) {
      return { attempted: 0, okTools: 0, okSkills: 0, failedSkills: [], partial: false }
    }
    const result: EnforceResult = { attempted: want.deniedTools.length, okTools: 0, okSkills: 0, failedSkills: [], partial: false }
    const disposers: Array<() => void> = []
    // 1) 工具 deny：schemas() 视图过滤（未知名在 0.2.2-rc.5 会 throw——先滤掉当前不存在的，
    //    其余 batch restrict，batch throw 再逐名降级。存在性过滤漏掉的（如 MCP 稍后连接）
    //    通过 partial 标记让 sweep 重试（0.5.1 修复一次性失败永久化）
    let denyList = want.deniedTools
    try {
      const existing = new Set<string>(ctx.tools.schemas().map((t) => t.name))
      denyList = want.deniedTools.filter((n) => existing.has(n))
    } catch { /* schemas 不可用时退回直传 */ }
    let toolsOk = false
    try {
      const d = agent.ctx.tools.restrict({ deny: denyList })
      if (typeof d === 'function') disposers.push(d)
      toolsOk = true
    } catch {
      trace(`restrict batch threw for ${sid}; falling back per-name`)
      for (const n of denyList) {
        try {
          const d = agent.ctx.tools.restrict({ deny: [n] })
          if (typeof d === 'function') disposers.push(d)
          toolsOk = true
        } catch (e) {
          trace(`restrict name ${n} threw for ${sid}: ${e}`)
        }
      }
    }
    result.okTools = toolsOk ? denyList.length : 0
    // 2) 技能 stub（辅助层；主生效通道是 snapshot patch。见文件头说明）
    for (const skillName of want.deniedSkills) {
      try {
        const d = agent.ctx.skills.register(makeDisabledStub(skillName, false) as any)
        if (typeof d === 'function') disposers.push(d)
        result.okSkills += 1
      } catch (e) {
        result.failedSkills.push(skillName)
        trace(`skill stub failed for ${skillName}@${sid}: ${e}`)
      }
    }
    result.partial = result.okTools < want.deniedTools.length || result.failedSkills.length > 0
    if (disposers.length > 0 || result.partial) {
      // 只在有成功挂载或有失败待重试时记录；partial 标记让 sweep 永不短路（但降频，见 ensureApplied）
      const prev = applied.get(sid)
      const failCount = result.partial ? ((prev?.failCount ?? 0) + 1) : 0
      applied.set(sid, { disposers, key: want.deniedTools.join(',') + '|' + want.deniedSkills.join(','), partial: result.partial, failCount, lastFailAt: result.partial ? Date.now() : 0 })
    } else {
      applied.delete(sid)
    }
    trace(`enforce(${sid}) tools=${result.okTools}/${result.attempted} skills=${result.okSkills}/${want.deniedSkills.length}${result.partial ? ' PARTIAL(will-retry)' : ''}`)
    return result
  }

  /** 幂等懒执行：deny 未变且上次无 partial 才短路。partial 永不短路（0.5.1 修复 M-1），
   *  但连续失败 5 次后进入 30s 降频退避（0.5.2 修复 W6 重试风暴） */
  const ensureApplied = (agent: Agent, rawSid: string): void => {
    const sid = normSid(rawSid)
    if (!sid) return
    const want = effective(sid)
    const wantKey = want.deniedTools.join(',') + '|' + want.deniedSkills.join(',')
    const prev = applied.get(sid)
    if (prev && !prev.partial && prev.key === wantKey) return
    if (prev && prev.partial && prev.failCount >= 5 && Date.now() - prev.lastFailAt < 30000) return // 退避窗口
    try {
      enforce(agent, sid)
    } catch (e) {
      trace(`ensureApplied(${sid}) failed: ${e}`)
    }
  }

  /** /set、/apply 的立即生效入口：agent live 则立即 enforce（保持「下一条消息生效」语义兜底） */
  const applyToSession = (sessionId: string, origGet: (id: string) => Agent | undefined): { ok: boolean; reason?: string; result?: EnforceResult } => {
    const sid = normSid(sessionId)
    if (!sid) return { ok: false, reason: 'invalid-session-id' }
    let agent: Agent | undefined
    try { agent = origGet(sid) ?? origGet('session-' + sid) } catch { agent = undefined }
    if (!agent) { trace(`applyToSession(${sid}) no-live-agent（将由 sweep/下一条消息接管）`); return { ok: false, reason: 'no-live-agent' } }
    return { ok: true, result: enforce(agent, sid) }
  }

  const applyAllLive = (origList: () => Agent[]): void => {
    try {
      for (const agent of origList()) {
        // 0.5.1：Agent 形状只有 id（0.2.2-rc.5 types.ts）——旧代码用 sessionId 恒空转
        const sid = normSid(String((agent as any).id ?? (agent as any).sessionId ?? ''))
        if (sid && (store.sessions[sid] || store.global.deniedTools.length || store.global.deniedSkills.length)) {
          ensureApplied(agent, sid)
        }
      }
    } catch { /* agents 服务不可用时静默 */ }
  }

  // ── agents.get/list 包装（0.5.1：守卫防重复包装 + ctx.effect 可还原）────
  let origGet: ((id: string) => Agent | undefined) | null = null
  let origList: (() => Agent[]) | null = null
  try {
    const agentsSvc = ctx.agents as unknown as { get(id: string): Agent | undefined; list(): Agent[] } & Record<string, unknown>
    if ((agentsSvc as any).__gate_wrapped !== true) {
      ;(agentsSvc as any).__gate_wrapped = true
      origGet = agentsSvc.get.bind(agentsSvc)
      origList = agentsSvc.list.bind(agentsSvc)
      agentsSvc.get = (id: string): Agent | undefined => {
        const a = origGet!(id)
        if (a) ensureApplied(a, id)
        return a
      }
      agentsSvc.list = (): Agent[] => {
        const all = origList!()
        for (const a of all) {
          const sid = normSid(String((a as any).id ?? ''))
          if (sid) ensureApplied(a, sid)
        }
        return all
      }
      ctx.effect(() => {
        trace('agents.get/list wrapped (lazy enforcement active)')
        // 周期 sweep：partial 会话自动重试（0.5.1）
        const t = setInterval(() => { try { agentsSvc.list() } catch { /* ignore */ } }, 2000)
        try { agentsSvc.list() } catch { /* ignore */ }
        return (): void => {
          clearInterval(t)
          // 还原包装（0.5.1：热重载/卸载不再残留双层）
          try { agentsSvc.get = origGet! } catch { /* ignore */ }
          try { agentsSvc.list = origList! } catch { /* ignore */ }
          try { delete (agentsSvc as any).__gate_wrapped } catch { /* ignore */ }
          trace('agents.get/list restored')
        }
      }, 'dsh-skillmcp-gate: agents wrap + sweep')
    } else {
      trace('agents already wrapped by another instance — skip (guard)')
      ctx.logger?.warn?.(`[${SHORT}] agents service already wrapped — another instance active? Skipping wrap.`)
    }
  } catch (e) {
    trace(`agents wrap failed: ${e}`)
  }

  // agent/created 兜底（信封/直读两种形状兼容为一个 handler；宿主在 agent carrier 派发，
  // 根层可达性依赖广播语义——主通道是 get/list 包装，此通道仅锦上添花）
  ;(ctx as any).on('agent/created', (payload: any) => {
    try {
      const agent = payload?.agent ?? payload
      const sid = String(agent?.id ?? agent?.session?.id ?? '')
      if (sid && typeof agent?.ctx === 'object') ensureApplied(agent, sid)
    } catch { /* ignore */ }
  })

  // ── HTTP API（client UI 消费；同源 fetch，无 CORS 需求）──────────

  const json = (res: any, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req: any): Promise<any> => {
    const chunks: Buffer[] = []
    let total = 0
    const MAX = 2 * 1024 * 1024 // 2MB 上限（0.5.1）
    for await (const c of req) {
      total += (c as Buffer).length
      if (total > MAX) throw new Error('request body too large')
      chunks.push(c as Buffer)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      // 0.5.2 修复 P1：null/数组/原始值等非对象 body 归一为 {}（属性访问不再 throw 500）
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed
    } catch { return {} }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: any, res: any) => {
      let route = ''
      try {
        // URL 构造入 try（0.5.1：畸形 url 不再悬挂连接）
        const url = new URL(req.url ?? '/', 'http://local')
        route = url.pathname.slice(API_PREFIX.length)
        if (req.method === 'GET' && (route === '/state' || route === '')) {
          // 与 /set 同键：registry 键带 session- 前缀、store 键是裸 uuid
          const rawSessionId = url.searchParams.get('sessionId') ?? ''
          const sessionId = normSid(rawSessionId)
          // cwd 一律宿主自算（0.5.1：删除 query cwd 参数——无消费方且构成任意目录探测面）
          let cwd = process.cwd()
          try {
            const wd = (ctx as any).workingDirectory as WorkingDirectoryService | undefined
            cwd = wd?.get?.(rawSessionId) ?? wd?.get?.(sessionId) ?? cwd
          } catch { /* 传字符串参数会 throw（0.2.2-rc.5 期望 Session 对象），落到进程 cwd */ }
          // 工具清单：mcp__server__tool 分组；其余 builtin（V1 不管控，仅展示）
          const tools = ctx.tools.schemas().map((t) => {
            const m = MCP_RE.exec(t.name)
            return m
              ? { name: t.name, kind: 'mcp' as const, server: m[1], tool: m[2], description: t.description ?? '' }
              : { name: t.name, kind: 'builtin' as const, server: '', tool: t.name, description: t.description ?? '' }
          }).sort((a, b) => (a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server)))
          // 技能清单：provider snapshot + 磁盘扫描兜底合并（source 沿用兜底标注）
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
            agentLive: sessionId ? !!(origGet && (origGet(rawSessionId) ?? origGet(sessionId))) : false,
            sessionsIndex: Object.fromEntries(
              Object.entries(store.sessions).map(([k, v]) => [k, { tools: v.deniedTools.length, skills: v.deniedSkills.length }]),
            ),
          })
        }
        if (req.method === 'POST' && route === '/set') {
          const body = await readBody(req)
          // 0.5.2 修复 W4：scope 显式白名单——未知值 400，不再静默降级为 session 写入
          const scope = body.scope === 'global' ? 'global' : body.scope === 'session' ? 'session' : null
          if (!scope) return json(res, 400, { error: `unknown scope: ${JSON.stringify(body.scope ?? null)} (expect "global" | "session")` })
          const sessionId = normSid(String(body.sessionId ?? ''))
          if (sessionId.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
            // 0.5.2 修复 W3：store 键长度与形态上限（fuzz 实测 5000 字符原样落盘）
            if (scope === 'session') return json(res, 400, { error: 'invalid sessionId (max 64 chars, [A-Za-z0-9._-])' })
          }
          const patch: DenialSet = {
            deniedTools: normalizeSet(body.deniedTools),
            // 0.5.2 修复 P3：deniedSkills 过滤当前 skills 快照中不存在的名字（幽灵在入口剥掉，
            // 不再经 stub 注册「成真」出现在面板清单，也不被 UI 全量回写复活）
            deniedSkills: normalizeSet(body.deniedSkills),
          }
          if (patch.deniedSkills.length > 0) {
            // 0.5.3 修复 N1（0.5.2 回归）：白名单必须与 /state 展示清单同源
            // （snapshot + scanSkillDirs 合并）——0.5.2 仅用无 scope snapshot，
            // dev 实测该清单与 /state 不一致（真实名被误杀 = skill 禁用静默失效）。
            // 两清单都为空时 fail-open 不过滤（可用性优先）。
            const known = new Set<string>()
            try { for (const s of (await ctx.skills.snapshot({ cwd: process.cwd() })).skills) known.add(s.name) } catch { /* fail-open 一部分 */ }
            try { for (const s of scanSkillDirs(process.cwd(), dshHome)) known.add(s.name) } catch { /* ignore */ }
            if (known.size > 0) patch.deniedSkills = patch.deniedSkills.filter((n) => known.has(n))
          }
          if (scope === 'global') {
            store.global = patch
          } else {
            if (!sessionId) return json(res, 400, { error: 'sessionId required for session scope' })
            // 空 delta = 回归继承 → 删除会话条目
            if (patch.deniedTools.length === 0 && patch.deniedSkills.length === 0) delete store.sessions[sessionId]
            else store.sessions[sessionId] = patch
          }
          // 0.5.1 修复 H-2：session 分支的 skills 写 global，必须在此之后统一落盘
          if (scope === 'session') store.global.deniedSkills = patch.deniedSkills
          persist()
          if (scope === 'session') {
            // 0.5.2：session 分支不再注册 stub——幽灵名经 stub 注册会「成真」出现在面板清单
            // （fuzz/UI 实测），且 stub 本就是辅助层；skill 生效主通道 = snapshot patch + global stub 重放
            const r = origGet ? applyToSession(sessionId, origGet) : { ok: false as const, reason: 'wrap-unavailable' }
            return json(res, 200, { ok: true, applied: r, globalSkills: patch.deniedSkills.length })
          }
          registerGlobalSkillStubs(store.global.deniedSkills)
          applyAllLive(origList ?? (() => []))
          return json(res, 200, { ok: true, applied: 'all-live' })
        }
        if (req.method === 'POST' && route === '/apply') {
          const body = await readBody(req)
          const sessionId = normSid(String(body.sessionId ?? '')) // 0.5.1 修复 M-3：补 normSid
          if (!sessionId) return json(res, 400, { error: 'sessionId required' })
          if (!origGet) return json(res, 503, { error: 'agents wrap unavailable' })
          return json(res, 200, { ok: true, applied: applyToSession(sessionId, origGet) })
        }
        return json(res, 404, { error: `unknown route ${req.method} ${route}` })
      } catch (e: any) {
        ctx.logger?.warn?.(`[${SHORT}] api error: ${e?.stack ?? e}`)
        return json(res, 500, { error: String(e?.message ?? e) })
      }
    },
  }), `${SHORT}: api`)

  // 重放全局 skill deny（重启后 stub 消失需重挂）
  if (store.global.deniedSkills.length > 0) registerGlobalSkillStubs(store.global.deniedSkills)

  // ── hook skills.snapshot：per-session 过滤被禁 skill ──────────────
  // 实测生效机制（0.2.2-rc.5）：agent-loop 把 agent 实例本身当 scope 传入，且 agent 携带 id
  // 字符串 → options.scope.id 命中。注意：这是未文档化实现巧合（ScopeKey 类型是 object），
  // DSH 升级后须回归验证「skill 禁用是否仍按会话过滤」。守卫防双实例重复包装（0.5.1）。
  try {
    const skillsAny = ctx.skills as any
    if (skillsAny.__gate_snapshot_patched !== true) {
      skillsAny.__gate_snapshot_patched = true
      const origSnapshot = skillsAny.snapshot.bind(skillsAny)
      skillsAny.snapshot = async (options: any) => {
        const result = await origSnapshot(options)
        try {
          const rawSid = String(options?.scope?.id ?? options?.scope?.session?.id ?? '')
          const sid = normSid(rawSid)
          if (!sid) return result
          const denied = effective(sid) // 0.5.1：包 try——畸形 store 不再打断宿主技能目录组装（fail-open）
          if (denied.deniedSkills.length === 0) return result
          const filtered = {
            ...result,
            skills: result.skills.filter((s: any) => !denied.deniedSkills.includes(s.name)),
          }
          trace(`snapshot filtered for ${sid}: ${result.skills.length} -> ${filtered.skills.length}`)
          return filtered
        } catch (e) {
          trace(`snapshot filter failed (fail-open): ${e}`)
          return result
        }
      }
      ctx.effect(() => {
        trace('skills.snapshot patched for per-session filtering')
        return (): void => {
          try { skillsAny.snapshot = origSnapshot } catch { /* ignore */ }
          try { delete skillsAny.__gate_snapshot_patched } catch { /* ignore */ }
          trace('skills.snapshot restored')
        }
      }, 'dsh-skillmcp-gate: snapshot patch')
    } else {
      trace('skills.snapshot already patched by another instance — skip (guard)')
    }
  } catch (e) {
    trace(`skills snapshot patch failed: ${e}`)
  }

  ctx.logger?.info?.(`[${SHORT}] ready — store=${storeFile}${loaded.corrupted ? ' (PREVIOUS FILE QUARANTINED)' : ''}`)
}
