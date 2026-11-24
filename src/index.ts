/**
 * dsh-skillmcp-gate — host 侧（0.5.5 实用性加固版）。
 * 按会话管控 skill / MCP 工具暴露集：
 *  - 工具：agent.ctx.tools.restrict({deny})（官方 scoped seam，下一条消息生效）
 *  - 技能：skills.snapshot monkey-patch 过滤（唯一生效通道）。stub 辅助层已移除——
 *    0.5.3 实测 agent-loop 的 agent ctx 未注入 skills，register 恒抛
 *    "cannot get property skills without inject"，stub 100% 失败且喂养 partial 重试风暴；
 *    SkillProvider 迁移见 V2。
 *  - 持久化：~/.dsh/storages/skillmcp-gate.json（原子写 tmp+rename；读失败分级处理；
 *    sessions 用 null 原型对象 + 保留键黑名单——0.5.5 修复原型键毒化）
 *  - 重放：agents.get/list 包装懒执行 + 2s sweep（partial 永不短路；退避计数跨轮累计——
 *    0.5.5 修复 detach 先删导致 failCount 恒 1 的死代码）
 *  - API 信任门（0.5.5）：Origin/Referer 同源校验 + 拒绝跨站 sec-fetch-site +
 *    写请求强制 application/json（堵浏览器 CSRF simple request 通道；
 *    本机脚本直连按「与 store 文件同权限」模型放行，绑定非 loopback 不受支持）
 *
 * ── 命名三分法（不可改契约，改动前必读）────────────────────────
 *  - 包名 dsh-skillmcp-gate：可改（需同步 package.json/host name/client PKG/tsdown PLUGIN_ID/cordis.patch.yml 五处）
 *  - 短名 skillmcp-gate：永久内部标识，永不随包名改——API 路由、store/trace 文件名、
 *    localStorage key（client）、cordis.patch.yml 的 id
 *  - slot key（client `${PKG}:panel`）：随包名改 = BREAKING（会话持久化旧 tab 失效）
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, appendFileSync, unlinkSync, statSync as stat } from 'node:fs'
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

type DenialSet = {
  deniedTools: string[]
  deniedSkills: string[]
  /** V2-1：显式解除名单（继承+覆写语义：解除全局默认、只在本会话放行） */
  releasedTools?: string[]
  releasedSkills?: string[]
}
type Store = { global: DenialSet; sessions: Record<string, DenialSet> }

const SHORT = 'skillmcp-gate' // 永久内部标识（见文件头命名三分法），禁止改为包名
const API_PREFIX = '/skillmcp-gate/api'
/** 贪心版：取最后一个 __ 作 server/tool 分隔；兼容含点/非 ASCII 的 server 名（0.5.1 放宽） */
const MCP_RE = /^mcp__(.+)__(.+)$/
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
/** normalizeSet 上限：防超长列表原样落盘并传宿主（0.5.1） */
const DENY_MAX_ITEMS = 1000
const DENY_MAX_NAME_LEN = 256
/** sessionId 形态校验 + Object.prototype 保留键黑名单（0.5.5 修复原型键毒化 store） */
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SID_MAX_LEN = 64
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'])
const isReservedKey = (key: string): boolean => PROTO_KEYS.has(key)
const validSid = (sid: string): boolean => sid.length <= SID_MAX_LEN && SID_RE.test(sid) && !isReservedKey(sid)
/** trace.log 轮转阈值 */
const TRACE_MAX_BYTES = 512 * 1024
/** old.log 保留上限：超过即删除（最多保留 2 代 ≈ 1MB，0.5.5 修复 old.log 无界增长） */
const TRACE_OLD_MAX_BYTES = TRACE_MAX_BYTES * 2

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
  // 0.5.5 修复 H5：trim 空白变体（大小写不折叠——工具名大小写敏感，折叠会错禁；
  // 变体防「禁不掉」由 /set 入口的同源白名单过滤完成）
  const cleaned = [...new Set((list as unknown[])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= DENY_MAX_NAME_LEN))].sort()
  return cleaned.slice(0, DENY_MAX_ITEMS)
}

function normalizeSessions(raw: Record<string, DenialSet>): Record<string, DenialSet> {
  // 键统一为裸 uuid（循环剥前缀防 session-session- 双前缀残留），元素过 normalizeSet 清洗
  // 0.5.5 修复 H2：out 用 null 原型对象——`out['constructor']` 不再命中 Object.prototype；
  // 保留键直接跳过；条目值非对象/数组形态畸形时剥为空而不是抛错（旧毒化 store 自愈，
  // 不再整库判 corrupted 隔离）
  const out: Record<string, DenialSet> = Object.create(null)
  for (const [k, v] of Object.entries(raw ?? {})) {
    let key = String(k)
    while (key.startsWith('session-')) key = key.slice('session-'.length)
    if (!key || isReservedKey(key)) continue
    const rec = (v && typeof v === 'object' && !Array.isArray(v) ? v : null) as Partial<DenialSet> | null
    // 0.5.2 修复 W5：空/非法条目不建幽灵键（sessionsIndex 不再显示 0/0 残留）
    const tools = normalizeSet(rec?.deniedTools)
    const skills = normalizeSet(rec?.deniedSkills)
    const relTools = normalizeSet(rec?.releasedTools)
    const relSkills = normalizeSet(rec?.releasedSkills)
    if (tools.length === 0 && skills.length === 0 && relTools.length === 0 && relSkills.length === 0) continue
    const cur = Object.prototype.hasOwnProperty.call(out, key) ? out[key] : { deniedTools: [], deniedSkills: [], releasedTools: [], releasedSkills: [] }
    out[key] = {
      deniedTools: [...new Set([...cur.deniedTools, ...tools])].sort(),
      deniedSkills: [...new Set([...cur.deniedSkills, ...skills])].sort(),
      releasedTools: [...new Set([...(cur.releasedTools ?? []), ...relTools])].sort(),
      releasedSkills: [...new Set([...(cur.releasedSkills ?? []), ...relSkills])].sort(),
    }
  }
  return out
}

function normalizeStore(raw: Partial<Store>): Store {
  return {
    global: {
      deniedTools: normalizeSet(raw.global?.deniedTools),
      deniedSkills: normalizeSet(raw.global?.deniedSkills),
      releasedTools: normalizeSet(raw.global?.releasedTools),
      releasedSkills: normalizeSet(raw.global?.releasedSkills),
    },
    sessions: normalizeSessions(raw.sessions ?? {}),
  }
}

/** 原地过滤：只保留 known 集合中的名字（0.5.5 /set 入口同源白名单共用） */
function patchFilter(list: string[], known: Set<string>): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!known.has(list[i])) list.splice(i, 1)
  }
}

const EMPTY_STORE: Store = { global: { deniedTools: [], deniedSkills: [], releasedTools: [], releasedSkills: [] }, sessions: Object.create(null) }

/**
 * V2-3b：存储后端抽象。
 *  - domain 后端：官方 storageDomain（dsh-storage-domain，base bundle 默认启用 → 零 profile 改动）
 *    → 获得 fsync 级原子写 + 单写链串行化 + schema 校验 + domain/changed 事件。
 *  - file 后端：旧 JSON 文件（~/.dsh/storages/skillmcp-gate.json）——域不可用/打开失败时的回退，
 *    同时保留旧文件供降级读取（域迁移完成后旧文件被 rename 为 .migrated-<stamp>，不删除）。
 */
type StoreBackend = {
  readonly kind: 'domain' | 'file'
  /** 读当前全局集合 */
  readGlobal: () => DenialSet
  /** 读某会话集合（不存在→空集） */
  readSession: (sessionId: string) => DenialSet | undefined
  /** 写全局集合 */
  writeGlobal: (next: DenialSet) => Promise<void>
  /** 写会话集合（undefined = 删除该键） */
  writeSession: (sessionId: string, next: DenialSet | undefined) => Promise<void>
  /** 列出全部会话键 */
  listSessions: () => Array<[string, DenialSet]>
  /** 是否可持久化（false = 本进程只读） */
  readonly persistent: boolean
  /** 关闭（域需要） */
  close?: () => Promise<void>
}

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

// ── V2-3b：storageDomain 官方 seam 适配 ────────────────────────────────
// 官方事实（dsh-storage-domain 0.2.2-rc.5）：
//  - 域声明 = defineDomain({name, version, global:{schema,initial}, tables})；record schema 用 **zod**
//  - 域名/表名必须匹配 /^[a-z][a-z0-9_]*$/（**不含连字符**）→ 域文件 skillmcp_gate.json
//  - 打开：ctx.storageDomain.open(spec)；可用 ctx.get('storageDomain') 取（缺失=undefined）。
//    **不可写成 inject: ['storageDomain']** —— 那会让插件在缺 storage 栈的 profile 里整体 park。
//  - 无值迁移 runner：旧文件→域 需自己写一次性转换（用 meta 表做幂等标记）。
//  - 域的 global 槽永远 reject；写入不做 schema 校验 → 现有 normalizeSet 清洗一行都不能删。
//  - domain/changed 仅进程内；跨进程一致性不由域解决（json backend 无跨进程写锁）。

/** 域内记录的 zod 校验（与 normalizeSet 输出一致：字符串数组） */
const denialSetShape = {
  deniedTools: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  deniedSkills: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  releasedTools: (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
  releasedSkills: (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
}
const isDenialSet = (v: unknown): v is DenialSet => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return denialSetShape.deniedTools(o.deniedTools) && denialSetShape.deniedSkills(o.deniedSkills)
    && denialSetShape.releasedTools(o.releasedTools) && denialSetShape.releasedSkills(o.releasedSkills)
}
const toDenialSet = (v: unknown): DenialSet => {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    deniedTools: normalizeSet(o.deniedTools),
    deniedSkills: normalizeSet(o.deniedSkills),
    releasedTools: normalizeSet(o.releasedTools),
    releasedSkills: normalizeSet(o.releasedSkills),
  }
}

/** 域后端：打开官方域 + 一次性迁移旧文件。返回 undefined 表示不可用（调用方回退文件后端）。 */
async function openDomainBackend(ctx: AppContext, legacyFile: string, trace: (m: string) => void): Promise<StoreBackend | undefined> {
  const facility = (ctx as any).get?.('storageDomain')
  if (!facility || typeof facility.open !== 'function') return undefined
  let domain: any
  try {
    // 域声明用运行时对象（避免硬依赖 zod：schema 用自校验函数，dsh-storage-domain 要求 ZodType，
    // 故此处走 duck-typing 的最小封装——若宿主要求真正的 zod schema，open 会失败并回退文件后端）
    const spec = {
      name: 'skillmcp_gate',
      version: 1,
      global: { schema: { parse: (v: unknown) => toDenialSet(v) }, initial: { deniedTools: [], deniedSkills: [], releasedTools: [], releasedSkills: [] } },
      tables: {
        sessions: { valueSchema: { parse: (v: unknown) => { if (!isDenialSet(v)) throw new TypeError('invalid denial set'); return toDenialSet(v) } } },
        meta: { valueSchema: { parse: (v: unknown) => (v && typeof v === 'object' ? v : {}) } },
      },
    }
    domain = await facility.open(spec)
  } catch (e) {
    trace(`storageDomain open failed — falling back to legacy file: ${e}`)
    ctx.logger?.warn?.(`[${SHORT}] storageDomain open failed — using legacy file store: ${e}`)
    return undefined
  }
  const table = domain.table('sessions')
  const meta = domain.table('meta')
  // 一次性迁移（旧文件 → 域）：幂等标记放 meta 表；旧文件 rename 是最后一步（崩溃可重跑）
  try {
    if (meta.get('migration')?.migrated !== true) {
      let legacy: { global: DenialSet; sessions: Record<string, DenialSet> } | undefined
      try {
        const raw = JSON.parse(readFileSync(legacyFile, 'utf8')) as any
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          legacy = { global: toDenialSet(raw.global), sessions: (raw.sessions ?? {}) as Record<string, DenialSet> }
        }
      } catch { legacy = undefined }
      if (legacy) {
        await domain.global.set(legacy.global)
        for (const [sid, rec] of Object.entries(legacy.sessions)) {
          await table.put(sid, toDenialSet(rec))
        }
        await meta.put('migration', { migrated: true })
        try { renameSync(legacyFile, legacyFile + '.migrated-' + Date.now()) } catch { /* 保留备份失败不致命 */ }
        trace(`legacy store migrated into storageDomain (${Object.keys(legacy.sessions).length} session entries)`)
      } else {
        await meta.put('migration', { migrated: true })
      }
    }
  } catch (e) {
    trace(`legacy migration failed: ${e}`)
    ctx.logger?.warn?.(`[${SHORT}] legacy store migration failed: ${e}`)
  }
  return {
    kind: 'domain',
    readGlobal: () => toDenialSet(domain.global.get()),
    readSession: (sessionId) => {
      const rec = table.get(sessionId)
      return rec === undefined ? undefined : toDenialSet(rec)
    },
    writeGlobal: async (next) => { await domain.global.set(next) },
    writeSession: async (sessionId, next) => {
      if (next === undefined) await table.delete(sessionId)
      else await table.put(sessionId, next)
    },
    listSessions: () => [...table.entries()].map(([k, v]) => [k, toDenialSet(v)] as [string, DenialSet]),
    persistent: true,
    close: async () => { try { await domain.close() } catch { /* ignore */ } },
  }
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

export async function apply(ctx: AppContext, config: Config): Promise<void> {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const storeFile = config.storeFile || join(dshHome, 'storages', SHORT + '.json')

  const traceFile = join(dirname(storeFile), SHORT + '.trace.log')
  const traceOldFile = traceFile.replace(/\.log$/, '.old.log')
  const trace = (msg: string): void => {
    try {
      mkdirSync(dirname(traceFile), { recursive: true })
      try {
        if (stat(traceFile).size > TRACE_MAX_BYTES) {
          // 0.5.5 修复 M8：old.log 超上限先删（历史无轮转版本可能残留超大文件）再轮转
          try { if (stat(traceOldFile).size > TRACE_OLD_MAX_BYTES) unlinkSync(traceOldFile) } catch { /* 不存在 */ }
          renameSync(traceFile, traceOldFile)
        }
      } catch { /* 首次不存在 */ }
      appendFileSync(traceFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* ignore */ }
  }
  // 0.5.5 修复 M8：启动时清理历史残留的超大 old.log（实测对照实例曾有 106MB）
  try { if (stat(traceOldFile).size > TRACE_OLD_MAX_BYTES) unlinkSync(traceOldFile) } catch { /* 不存在 */ }

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

  // V2-3b：优先官方 storageDomain（域后端）；不可用/打开失败 → 回退旧文件后端
  const domainBackend = await openDomainBackend(ctx, storeFile, trace)
  const backend: StoreBackend = domainBackend ?? {
    kind: 'file',
    readGlobal: () => store.global,
    readSession: (sessionId) => store.sessions[sessionId],
    writeGlobal: async (next) => { store.global = next },
    writeSession: async (sessionId, next) => {
      if (next === undefined) delete store.sessions[sessionId]
      else store.sessions[sessionId] = next
    },
    listSessions: () => Object.entries(store.sessions).map(([k, v]) => [k, v] as [string, DenialSet]),
    persistent: !storeQuarantined,
  }
  if (domainBackend) {
    // 域后端：把域内数据灌入内存（保持同步读路径），此后内存为准、持久化由域承接
    try {
      store.global = backend.readGlobal()
      const sessions = backend.listSessions()
      for (const [k, v] of sessions) store.sessions[k] = v
      trace(`store backend = storageDomain (skillmcp_gate): loaded global + ${sessions.length} session entries; legacy file = ${storeFile}`)
      ctx.logger?.info?.(`[${SHORT}] store backend = storageDomain (skillmcp_gate) — ${sessions.length} session entries loaded`)
    } catch (e) {
      trace(`domain initial load failed: ${e}`)
    }
  } else {
    trace(`store backend = legacy file (${storeFile})`)
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

  // 0.5.5：skill stub 辅助层整体移除（makeDisabledStub/registerGlobalSkillStubs/globalSkillDisposers）
  // ——0.5.3 实测 agent-loop agent ctx 未注入 skills，stub 注册恒抛错且喂养 partial 重试风暴；
  // skill 禁用唯一生效通道 = skills.snapshot patch（下方）。

  // V2-3b：域写入串行化（Windows 上并发 rename 同一目标会 EPERM——域的原子写用 rename 覆盖，
  //   两个写同时进行时后者 rename 前者正在替换的目标 → EPERM 落盘失败）。
  //   故：所有域写排队到单链上，且**只写本次变更的增量**（不是全量重写）。
  let domainWriteChain: Promise<void> = Promise.resolve()
  const enqueueDomainWrite = (task: () => Promise<void>): void => {
    domainWriteChain = domainWriteChain.then(async () => {
      try { await task() } catch (e) {
        trace(`domain write failed: ${e}`)
        ctx.logger?.warn?.(`[${SHORT}] domain write failed: ${e}`)
      }
    })
  }

  const persist = (): void => {
    if (storeQuarantined) { trace('persist skipped (store quarantined this process)'); return }
    if (backend.kind === 'domain') {
      // 全量同步（内存 → 域）：内存 store 是真相源；域里多出的行要删、内存有的行要写
      // （rv2-api P0-1 根因：域后端 listSessions() 返回的是域表自身行，用它回写是 no-op）
      enqueueDomainWrite(async () => {
        await backend.writeGlobal(store.global)
        const domainKeys = new Set(backend.listSessions().map(([k]) => k))
        for (const [sid, rec] of Object.entries(store.sessions)) {
          await backend.writeSession(sid, rec)
          domainKeys.delete(sid)
        }
        for (const sid of domainKeys) await backend.writeSession(sid, undefined)
      })
      try { invalidateSkillCatalog?.() } catch { /* ignore */ }
      return
    }
    try { saveStore(storeFile, store) } catch (e) { ctx.logger?.warn?.(`[${SHORT}] store save failed: ${e}`) }
    // V2-1：禁用集合变了 → 让 registry 的目录缓存失效，否则模型侧仍看到旧技能目录
    try { invalidateSkillCatalog?.() } catch { /* ignore */ }
  }

  /** V2-1 继承+覆写语义：global 是默认禁用集，session 的 released* 是「本会话放行」，
   *  session 的 denied* 是「本会话额外禁用」。最终生效 = (global ∪ session.denied) − released。
   *  这让「某会话单独放行一个全局被禁的 skill」成为可能（此前只有全局/会话二选一）。 */
  const effective = (sessionId: string | null): DenialSet => {
    const g = store.global
    const s = sessionId ? store.sessions[sessionId] : undefined
    const denyT = new Set([...g.deniedTools, ...(s?.deniedTools ?? [])])
    const denyS = new Set([...g.deniedSkills, ...(s?.deniedSkills ?? [])])
    for (const n of (s?.releasedTools ?? [])) denyT.delete(n)
    for (const n of (s?.releasedSkills ?? [])) denyS.delete(n)
    for (const n of (g.releasedTools ?? [])) denyT.delete(n)
    for (const n of (g.releasedSkills ?? [])) denyS.delete(n)
    return {
      deniedTools: [...denyT].sort(),
      deniedSkills: [...denyS].sort(),
      releasedTools: [...(s?.releasedTools ?? [])].sort(),
      releasedSkills: [...(s?.releasedSkills ?? [])].sort(),
    }
  }

  // ── 统一 enforcement（0.5.1 修复 M-8 双实现分叉 / M-1 partial 永久短路）──

  /** 按会话键找 agent：registry 键 = session-<uuid>，裸 uuid / 带前缀原文都兼容（0.5.5 修复 M-3 口径） */
  const findAgent = (rawId: string): Agent | undefined => {
    if (!origGet) return undefined
    const sid = normSid(rawId)
    const candidates = [...new Set([String(rawId ?? ''), sid, 'session-' + sid])].filter((k) => k.length > 0)
    for (const key of candidates) {
      try {
        const a = origGet(key)
        if (a) return a
      } catch { /* 单键形状不可用则试下一个 */ }
    }
    return undefined
  }

  const detach = (sid: string): void => {
    const prev = applied.get(sid)
    if (prev) {
      for (const d of prev.disposers) { try { d() } catch { /* scope 已销毁 */ } }
      applied.delete(sid)
    }
  }

  // ── V2-3：工具枚举视图（agent 作用域视图）────────────────────────
  // 事实（dsh-tools 0.2.2-rc.5 源码）：`ctx.tools.schemas()` 不传 scope = **全局视图**
  //   （view(undefined) 只取 layers.global）；preset scope 层里的工具（pwsh / read / grep /
  //   glob / web_search / todo_write …）因此不可见——它们并非「harness 注入面」，
  //   而是注册在 agent-preset scope 层的 registry 工具。
  //   agent 实例本身即 ScopeKey（assembleContextFor: {agent, scope: agent}），
  //   故 `ctx.tools.schemas(agent)` 即该会话的完整工具集。
  //   restrict() 的可禁集合 = 继承面（global + 祖先 scope 层）→ preset 层工具**可禁**。
  //   ⇒ 内置工具管控不需要新执行通道，只需把枚举源换成 agent 视图。
  const toolViewFor = (agent?: Agent): ToolSchema[] => {
    if (agent) {
      try {
        const scoped = ctx.tools.schemas(agent as unknown as object)
        if (scoped.length > 0) return scoped
      } catch (e) {
        trace(`agent-scoped tools.schemas failed: ${e}`)
      }
    }
    try { return ctx.tools.schemas() } catch { return [] }
  }

  /** 无活会话时的 preset 作用域视图（内置工具全集）——agentPresets.acquireScope 是异步且需 dispose。
   *  失败/不可用时返回 undefined（调用方回落全局视图）。 */
  const presetToolView = async (): Promise<ToolSchema[] | undefined> => {
    // agentPresets 是 TypertRemoteService —— 必须经 ctx.get('agentPresets') 取（属性访问取不到）
    const presets = (ctx as any).get?.('agentPresets')
    if (!presets || typeof presets.acquireScope !== 'function') return undefined
    let lease: any
    try {
      lease = await presets.acquireScope()
      const scoped = ctx.tools.schemas(lease.key as unknown as object)
      return scoped.length > 0 ? scoped : undefined
    } catch (e) {
      trace(`preset-scoped tools.schemas failed: ${e}`)
      return undefined
    } finally {
      try { await lease?.[Symbol.asyncDispose]?.() } catch { /* ignore */ }
    }
  }

  /** 已知工具名全集（幽灵名过滤用）：全局视图 ∪ 目标会话视图 ∪ 所有活会话视图 ∪ preset 视图。
   *  V2-3 修复 rv2-api P0-2：非活会话/global scope 下内置工具（pwsh/read/grep）不得被当幽灵剥除。 */
  const knownToolNames = async (sessionId?: string | undefined): Promise<Set<string>> => {
    const known = new Set<string>()
    try { for (const t of ctx.tools.schemas()) known.add(t.name) } catch { /* fail-open */ }
    try { for (const t of toolViewFor(sessionId ? findAgent(sessionId) : undefined)) known.add(t.name) } catch { /* fail-open */ }
    try {
      for (const a of (origList?.() ?? [])) for (const t of toolViewFor(a)) known.add(t.name)
    } catch { /* fail-open */ }
    try {
      const presetView = await presetToolView()
      if (presetView) for (const t of presetView) known.add(t.name)
    } catch { /* fail-open */ }
    return known
  }

  // ── V2-2：失败分类（暂时 / 永久）──────────────────────────────────
  // 永久失败 = 该名字在 agent 的已知工具集里不存在（改名/下线/换 preset 后不可恢复）
  //   或连续失败达阈值（不在可禁继承面内，restrict 永远抛错）→ 不再重试，提示用户。
  // 暂时失败 = 工具存在但本次挂载失败（MCP 尚未连接等）→ 按原有退避重试。
  type ToolFailure = { name: string; kind: 'temporary' | 'permanent'; reason: string; fails: number }
  /** 失败记录按会话隔离（V2-2 修复：此前全局单表 + 空集清理 → 任一无禁用的活会话每 2s 清空所有人的失败记录） */
  const toolFailures = new Map<string, Map<string, ToolFailure>>()
  const FAIL_PERMANENT_AFTER = 3
  const classifyFailure = (sid: string, name: string, known: Set<string>, error: unknown): ToolFailure => {
    const perSession = toolFailures.get(sid) ?? new Map<string, ToolFailure>()
    if (!toolFailures.has(sid)) toolFailures.set(sid, perSession)
    const prev = perSession.get(name)
    const fails = (prev?.fails ?? 0) + 1
    const reason = String((error as any)?.message ?? error ?? 'unknown').slice(0, 160)
    // 名字不在该会话已知工具集 → 永久（白名单也会在入口剥掉它）
    const kind: 'temporary' | 'permanent' = (!known.has(name) || fails >= FAIL_PERMANENT_AFTER) ? 'permanent' : 'temporary'
    const failure: ToolFailure = { name, kind, reason, fails }
    perSession.set(name, failure)
    return failure
  }
  /** 清理该会话已不再被禁用的失败记录（只动本会话） */
  const pruneFailures = (sid: string, activeNames: Set<string>): void => {
    const perSession = toolFailures.get(sid)
    if (!perSession) return
    for (const key of [...perSession.keys()]) if (!activeNames.has(key)) perSession.delete(key)
    if (perSession.size === 0) toolFailures.delete(sid)
  }

  type EnforceResult = { attempted: number; okTools: number; partial: boolean; failures: ToolFailure[] }

  /** 对单个 agent 挂 enforcement：先拆旧再挂新，返回精确成败（调用方决定记录策略）。
   *  Skill 侧已收敛为 snapshot patch 单通道（0.5.5 移除 stub 层）——enforce 只管工具 restrict。 */
  const enforce = (agent: Agent, sid: string): EnforceResult => {
    // 0.5.5 修复 H4：先读旧记录再 detach——旧实现先删后读，failCount 恒 1，退避成死代码
    const prevRecord = applied.get(sid)
    detach(sid)
    const want = effective(sid)
    if (want.deniedTools.length === 0) {
      pruneFailures(sid, new Set())
      return { attempted: 0, okTools: 0, partial: false, failures: [] }
    }
    const result: EnforceResult = { attempted: want.deniedTools.length, okTools: 0, partial: false, failures: [] }
    const disposers: Array<() => void> = []
    // 工具 deny：按 **agent 作用域视图** 过滤（V2-3：全局视图看不到 preset 层工具，
    // 会把 pwsh/read/grep 等真实内置工具误当幽灵丢掉）。
    // 未知名在 0.2.2-rc.5 会 throw——先滤掉当前不存在的，其余 batch restrict，
    // batch throw 再逐名降级。剩余失败按 V2-2 分类：永久失败不再重试。
    const known = new Set<string>(toolViewFor(agent).map((t) => t.name))
    const denyList = want.deniedTools.filter((n) => known.has(n))
    // 不在已知集合里的名字 = 永久失败（该会话没有这个工具）
    for (const n of want.deniedTools) {
      if (!known.has(n)) result.failures.push(classifyFailure(sid, n, known, 'not present in this session tool set'))
    }
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
          // V2-2：分类——名字不在已知集合 = 永久；否则连续失败达阈值 = 永久（不可禁面）
          result.failures.push(classifyFailure(sid, n, known, e))
        }
      }
    }
    result.okTools = toolsOk ? denyList.length : 0
    // V2-2：partial 只统计**暂时**失败（永久失败不再重试，不制造风暴）
    const temporary = result.failures.filter((f) => f.kind === 'temporary')
    result.partial = temporary.length > 0
    // 成功项清除历史失败记录（仅本会话）
    const perSessionFailures = toolFailures.get(sid)
    if (perSessionFailures) {
      for (const n of denyList) if (!result.failures.some((f) => f.name === n)) perSessionFailures.delete(n)
    }
    if (disposers.length > 0 || result.partial) {
      // 只在有成功挂载或有失败待重试时记录；partial 标记让 sweep 永不短路（但降频，见 ensureApplied）
      const failCount = result.partial ? ((prevRecord?.failCount ?? 0) + 1) : 0
      applied.set(sid, { disposers, key: want.deniedTools.join(','), partial: result.partial, failCount, lastFailAt: result.partial ? Date.now() : 0 })
    } else {
      applied.delete(sid)
    }
    trace(`enforce(${sid}) tools=${result.okTools}/${result.attempted}${result.partial ? ' PARTIAL(will-retry)' : ''}${result.failures.length ? ` failures=${result.failures.map((f) => `${f.name}:${f.kind}`).join(',')}` : ''}`)
    return result
  }

  /** 幂等懒执行：deny 未变且上次无 partial 才短路。partial 永不短路（0.5.1 修复 M-1），
   *  但连续失败 5 次后进入 30s 降频退避（0.5.2 修复 W6 重试风暴；0.5.5 修复 H4 使其真实可达）。
   *  返回本轮执行结果（null = 短路或执行抛错） */
  const ensureApplied = (agent: Agent, rawSid: string): EnforceResult | null => {
    const sid = normSid(rawSid)
    if (!sid) return null
    const want = effective(sid)
    const wantKey = want.deniedTools.join(',')
    const prev = applied.get(sid)
    if (prev && !prev.partial && prev.key === wantKey) return null
    if (prev && prev.partial && prev.failCount >= 5 && Date.now() - prev.lastFailAt < 30000) return null // 退避窗口
    try {
      return enforce(agent, sid)
    } catch (e) {
      trace(`ensureApplied(${sid}) failed: ${e}`)
      return null
    }
  }

  /** /set、/apply 的立即生效入口：agent live 则立即 enforce（保持「下一条消息生效」语义兜底）。
   *  0.5.5 修复 M-4：区分 session-not-found（无规则可应用）与 no-live-agent（有规则但无活会话） */
  const applyToSession = (sessionId: string): { ok: boolean; reason?: string; result?: EnforceResult } => {
    const sid = normSid(sessionId)
    if (!sid) return { ok: false, reason: 'invalid-session-id' }
    const sessionEntryExists = Object.prototype.hasOwnProperty.call(store.sessions, sid)
    if (!sessionEntryExists && effective(sid).deniedTools.length === 0) return { ok: false, reason: 'session-not-found' }
    const agent = findAgent(sessionId)
    if (!agent) { trace(`applyToSession(${sid}) no-live-agent（将由 sweep/下一条消息接管）`); return { ok: false, reason: 'no-live-agent' } }
    return { ok: true, result: enforce(agent, sid) }
  }

  /** 全部活会话立即生效的聚合结果（0.5.5 修复 H3：/set global 不再假报成功） */
  const applyAllLive = (origList: () => Agent[]): { attempted: number; enforced: number; partial: number } => {
    const summary = { attempted: 0, enforced: 0, partial: 0 }
    try {
      for (const agent of origList()) {
        // 0.5.1：Agent 形状只有 id（0.2.2-rc.5 types.ts）——旧代码用 sessionId 恒空转
        const sid = normSid(String((agent as any).id ?? (agent as any).sessionId ?? ''))
        if (sid && (Object.prototype.hasOwnProperty.call(store.sessions, sid) || store.global.deniedTools.length)) {
          summary.attempted += 1
          const r = ensureApplied(agent, sid)
          if (r === null) continue // 短路（已生效且无变化）或执行抛错
          if (r.partial) summary.partial += 1
          else summary.enforced += 1
        }
      }
    } catch { /* agents 服务不可用时静默 */ }
    return summary
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
        if (a) { ensureSessionSkillProvider(a); ensureApplied(a, id) }
        return a
      }
      agentsSvc.list = (): Agent[] => {
        const all = origList!()
        for (const a of all) {
          const sid = normSid(String((a as any).id ?? ''))
          if (sid) { ensureSessionSkillProvider(a); ensureApplied(a, sid) }
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

  // ── API 信任门（0.5.5 修复 H1：DSH 不给插件路由套认证，route owner 自管）──
  // 浏览器侧：Origin/Referer 必须同 authority + 拒绝跨站 sec-fetch-site + 写请求强制
  // application/json（堵 text/plain simple request 的 CSRF 通道）。
  // 本机脚本（无这些 header）按「与 store 文件同权限」模型放行——能打到 loopback 端口的
  // 进程本就能直接改 store 文件；绑定非 loopback 不受支持（DSH 自身也拒绝 0.0.0.0）。
  const sameAuthority = (urlStr: unknown, hostHeader: string): boolean => {
    try { return new URL(String(urlStr)).host === hostHeader } catch { return false }
  }
  const requestTrusted = (req: any): boolean => {
    const hostHeader = String(req.headers?.host ?? '')
    if (!hostHeader) return false
    const secFetchSite = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
    if (secFetchSite === 'cross-site') return false
    const origin = req.headers?.origin
    if (origin !== undefined && origin !== 'null' && !sameAuthority(origin, hostHeader)) return false
    const referer = req.headers?.referer
    if (referer !== undefined && !sameAuthority(referer, hostHeader)) return false
    return true
  }

  /** 读 body。编码化错误：超限 throw BodyTooLargeError（→413）；非法 JSON throw Error('invalid JSON body')（→400） */
  class BodyTooLargeError extends Error {}
  const readBody = async (req: any): Promise<any> => {
    const chunks: Buffer[] = []
    let total = 0
    const MAX = 2 * 1024 * 1024 // 2MB 上限（0.5.1）
    for await (const c of req) {
      total += (c as Buffer).length
      if (total > MAX) throw new BodyTooLargeError('request body too large')
      chunks.push(c as Buffer)
    }
    try {
      // 0.5.5：剥 UTF-8 BOM 再解析；空 body 视为 {}（由上层 scope 校验给出可读错误）
      const raw = Buffer.concat(chunks).toString('utf8')
      const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      const parsed = JSON.parse(clean || '{}') as unknown
      // 0.5.2 修复 P1：null/数组/原始值等非对象 body 归一为 {}（属性访问不再 throw 500）
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed
    } catch (e) {
      if (e instanceof BodyTooLargeError) throw e
      throw new Error('invalid JSON body')
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: any, res: any) => {
      let route = ''
      try {
        // ── 信任门（0.5.5 修复 H1）：跨站/异源请求一律 403 ──
        if (!requestTrusted(req)) return json(res, 403, { error: 'cross-origin request rejected' })
        // 写请求强制 application/json（堵 text/plain simple request CSRF 通道）
        if (req.method === 'POST') {
          const ct = String(req.headers?.['content-type'] ?? '').toLowerCase()
          if (!ct.startsWith('application/json')) return json(res, 415, { error: 'content-type must be application/json' })
        }
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
          // 工具清单：mcp__server__tool 分组；其余 builtin（V2-3：agent 作用域视图，
          // 含 preset 层工具 pwsh/read/grep/web_search 等 → 内置工具现可管控）
          const liveAgent = findAgent(rawSessionId)
          const tools = toolViewFor(liveAgent).map((t) => {
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
          const sidKey = sessionId
          const session = sidKey && Object.prototype.hasOwnProperty.call(store.sessions, sidKey) ? store.sessions[sidKey] : null
          // 0.5.5 修复 L5：applied 只序列化诊断字段（disposers 是函数，JSON 后恒 null 无信息量）
          const ap = sessionId ? (applied.get(sessionId) ?? null) : null
          const appliedSummary = ap ? { key: ap.key, partial: ap.partial, failCount: ap.failCount, lastFailAt: ap.lastFailAt } : null
          // V2-2：失败分类（永久失败 = 该会话工具集里没有 / 不可禁；暂时失败 = 稍后重试）
          const relevantNames = new Set<string>(effective(sessionId).deniedTools)
          const perSessionFailures = sessionId ? (toolFailures.get(sessionId) ?? new Map<string, ToolFailure>()) : new Map<string, ToolFailure>()
          const failures = [...perSessionFailures.values()]
            .filter((f) => relevantNames.has(f.name) || f.kind === 'permanent')
            .map((f) => ({ name: f.name, kind: f.kind, reason: f.reason, fails: f.fails }))
          // V2-3 修复（rv2-ui 发现的中危）：被禁工具因 restrict 从清单消失 → 面板看不到 →
          //   下次「批量应用」的全量回写把它静默丢弃（用户无法看到/恢复已禁用项）。
          //   ⇒ /state 补回「已禁用但当前视图不可见」的条目（hidden 标记），UI 照常显示为已禁用。
          const toolNames = new Set(tools.map((t) => t.name))
          const effTools = effective(sessionId)
          for (const deniedName of effTools.deniedTools) {
            if (toolNames.has(deniedName)) continue
            tools.push({ name: deniedName, kind: deniedName.startsWith('mcp__') ? 'mcp' : 'builtin', server: deniedName.startsWith('mcp__') ? (MCP_RE.exec(deniedName)?.[1] ?? '') : '', tool: deniedName.startsWith('mcp__') ? (MCP_RE.exec(deniedName)?.[2] ?? deniedName) : deniedName, description: '已禁用（当前工具集中不可见）' })
          }
          tools.sort((a, b) => (a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server)))
          const mcpServers2 = [...new Set(tools.filter((t) => t.kind === 'mcp').map((t) => t.server!))]
          return json(res, 200, {
            sessionId,
            cwd,
            tools,
            skills,
            skillsComplete,
            mcpServers: mcpServers2,
            global: store.global,
            session,
            applied: appliedSummary,
            failures,
            // 0.5.5 修复 M-3：findAgent 兼容 registry 实际键 session-<uuid>（裸 uuid 不再恒 false）
            agentLive: sessionId ? !!findAgent(rawSessionId) : false,
            sessionsIndex: Object.fromEntries(
              Object.entries(store.sessions).map(([k, v]) => [k, { tools: v.deniedTools.length, skills: v.deniedSkills.length }]),
            ),
          })
        }
        if (req.method === 'POST' && route === '/set') {
          let body: any
          try {
            body = await readBody(req)
          } catch (e: any) {
            if (e instanceof BodyTooLargeError) return json(res, 413, { error: 'request body too large (max 2MB)' })
            // 0.5.5 修复 L1：非法 JSON 不再伪装成 scope 错误
            return json(res, 400, { error: String(e?.message ?? e) })
          }
          // 0.5.2 修复 W4：scope 显式白名单——未知值 400，不再静默降级为 session 写入
          const scope = body.scope === 'global' ? 'global' : body.scope === 'session' ? 'session' : null
          if (!scope) return json(res, 400, { error: `unknown scope: ${JSON.stringify(body.scope ?? null)} (expect "global" | "session")` })
          const sessionId = normSid(String(body.sessionId ?? ''))
          if (scope === 'session') {
            // 0.5.5 修复 L1/H2：缺失/超长/非法字符/保留键分别报因；保留键（constructor 等）直接拒绝
            if (!sessionId) return json(res, 400, { error: 'sessionId required for session scope' })
            if (isReservedKey(sessionId)) return json(res, 400, { error: 'sessionId is a reserved key' })
            if (sessionId.length > SID_MAX_LEN) return json(res, 400, { error: `sessionId too long (max ${SID_MAX_LEN} chars)` })
            if (!SID_RE.test(sessionId)) return json(res, 400, { error: 'invalid sessionId (chars limited to [A-Za-z0-9._-], must not start with -)' })
          }
          // 0.5.5 修复 M1：字段可选语义——缺省 = 保持该字段现值（tools-only 调用方不再抹掉 skills 禁用）
          // V2-1：新增 released* 字段（session scope = 本会话放行；global scope = 全局默认放行）
          const hasT = Array.isArray(body.deniedTools)
          const hasS = Array.isArray(body.deniedSkills)
          const hasRT = Array.isArray(body.releasedTools)
          const hasRS = Array.isArray(body.releasedSkills)
          const current = scope === 'global'
            ? store.global
            : (sessionId && Object.prototype.hasOwnProperty.call(store.sessions, sessionId) ? store.sessions[sessionId] : { deniedTools: [], deniedSkills: [], releasedTools: [], releasedSkills: [] })
          const nextTools = hasT ? normalizeSet(body.deniedTools) : [...current.deniedTools]
          const nextSkills = hasS ? normalizeSet(body.deniedSkills) : [...current.deniedSkills]
          const nextRelTools = hasRT ? normalizeSet(body.releasedTools) : [...(current.releasedTools ?? [])]
          const nextRelSkills = hasRS ? normalizeSet(body.releasedSkills) : [...(current.releasedSkills ?? [])]
          if (hasS && nextSkills.length > 0) {
            // 0.5.3 修复 N1（0.5.2 回归）：白名单必须与 /state 展示清单同源
            // （snapshot + scanSkillDirs 合并）——两清单都为空时 fail-open 不过滤（可用性优先）。
            const known = new Set<string>()
            try { for (const s of (await ctx.skills.snapshot({ cwd: process.cwd() })).skills) known.add(s.name) } catch { /* fail-open 一部分 */ }
            try { for (const s of scanSkillDirs(process.cwd(), dshHome)) known.add(s.name) } catch { /* ignore */ }
            if (known.size > 0) {
              for (const n of nextSkills) if (!known.has(n)) trace(`ghost skill name stripped at entry: ${n}`)
              patchFilter(nextSkills, known)
            }
          }
          if (hasT && nextTools.length > 0) {
            // 0.5.5 修复 H5/M2：tools 侧同源白名单（与 /state tools 清单一致）——
            // 变体名/幽灵名在入口剥除，「禁不掉却显示已禁用」与 partial 重试风暴不再产生。
            // V2-3：白名单 = 全局视图 ∪ 目标会话 agent 视图 ∪ **所有活会话的 agent 视图**
            //   （否则非活会话/global scope 下 pwsh/read/grep 会被当幽灵剥掉 → 内置工具无法管控；
            //    rv2-api P0-2 根因）。
            const knownTools = await knownToolNames(sessionId)
            if (knownTools.size > 0) {
              for (const n of nextTools) if (!knownTools.has(n)) trace(`ghost tool name stripped at entry: ${n}`)
              patchFilter(nextTools, knownTools)
            }
          }
          const written: DenialSet = {
            deniedTools: nextTools,
            deniedSkills: nextSkills,
            releasedTools: nextRelTools,
            releasedSkills: nextRelSkills,
          }
          if (scope === 'global') {
            store.global = written
          } else {
            // 空 delta = 回归继承 → 删除会话条目
            if (nextTools.length === 0 && nextSkills.length === 0 && nextRelTools.length === 0 && nextRelSkills.length === 0) delete store.sessions[sessionId]
            else store.sessions[sessionId] = written
          }
          persist()
          if (scope === 'session') {
            const r = origGet ? applyToSession(sessionId) : { ok: false as const, reason: 'wrap-unavailable' }
            // 0.5.5 修复 L2：回显归一化后的生效键
            return json(res, 200, { ok: true, scope, sessionId, applied: r })
          }
          const summary = applyAllLive(origList ?? (() => []))
          // 0.5.5 修复 H3：返回真实聚合（attempted/enforced/partial），不再硬编码 all-live 假成功
          return json(res, 200, { ok: true, scope, applied: summary, partial: summary.partial > 0 })
        }
        if (req.method === 'POST' && route === '/apply') {
          let body: any
          try {
            body = await readBody(req)
          } catch (e: any) {
            if (e instanceof BodyTooLargeError) return json(res, 413, { error: 'request body too large (max 2MB)' })
            return json(res, 400, { error: String(e?.message ?? e) })
          }
          // 0.5.5 修复 M4：/apply 与 /set 同一套形态校验
          const sessionId = normSid(String(body.sessionId ?? ''))
          if (!sessionId) return json(res, 400, { error: 'sessionId required' })
          if (isReservedKey(sessionId)) return json(res, 400, { error: 'sessionId is a reserved key' })
          if (sessionId.length > SID_MAX_LEN) return json(res, 400, { error: `sessionId too long (max ${SID_MAX_LEN} chars)` })
          if (!SID_RE.test(sessionId)) return json(res, 400, { error: 'invalid sessionId (chars limited to [A-Za-z0-9._-], must not start with -)' })
          if (!origGet) return json(res, 503, { error: 'agents wrap unavailable' })
          return json(res, 200, { ok: true, sessionId, applied: applyToSession(sessionId) })
        }
        return json(res, 404, { error: `unknown route ${req.method} ${route}` })
      } catch (e: any) {
        if (e instanceof BodyTooLargeError) return json(res, 413, { error: 'request body too large (max 2MB)' })
        ctx.logger?.warn?.(`[${SHORT}] api error: ${e?.stack ?? e}`)
        return json(res, 500, { error: String(e?.message ?? e) })
      }
    },
  }), `${SHORT}: api`)

  // ── V2-1：skill 管控迁移官方 SkillProvider seam ────────────────────
  // 官方 seam（dsh-skill 0.2.2-rc.5 已验证）：
  //   ① ctx.skills.registerProvider(create) → provider 落进「调用方 ctx 的 scope 层」
  //      （宿主文档：unscoped ctx → 全局层；带 scope 的 ctx → 该 scope 层）
  //   ② 候选按 name 合并：同层内 rank 小者胜（compareIndexedCandidates），
  //      跨层则「近作用域覆盖远作用域」（collectFresh：merged.set(name, entry)）
  //   ③ 模型侧技能目录 = snapshot.skills.filter(isModelInvocable)（dsh-tool-skill L226-229），
  //      skill 工具加载路径同样拒绝非 model-invocable（dsh-tool-skill L142-150）
  //   → 方案：用 rank=50 的 shadow 候选（同 name、modelInvocable=false）压过所有来源
  //     （project-dsh 100 / project-agents 200 / custom 300 / user-dsh 400 /
  //       user-agents 500 / bundled 600），模型既看不到该 skill，工具也拒绝加载。
  //   → 比 0.5.x 的 snapshot monkey-patch 更强：旧实现只在目录层过滤，
  //     模型若直接点名仍能用 skill 工具加载被禁 skill。
  // 旧宿主（无 registerProvider）退回 0.5.x 的 snapshot patch 兜底。
  const SKILL_GATE_PROVIDER = 'dsh-skillmcp-gate'
  const SKILL_GATE_PROVIDER_SESSION = 'dsh-skillmcp-gate-session'
  const SKILL_GATE_RANK = 50
  /** 宿主 skill 名文法（dsh-skill SKILL_NAME）：非法名不得进入 provider，否则整个 list() 校验失败 */
  const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  const DISABLED_SKILL_DESC = '[disabled] 该 Skill 已被用户禁用（dsh-skillmcp-gate）'
  const disabledSkillContent = (name: string): string =>
    `# ${name}（disabled）\n\n该 Skill 已被用户禁用（dsh-skillmcp-gate）。不要尝试使用它；如任务需要该能力，请如实告知用户。`

  /** 禁用集合变更后让 registry 的目录缓存失效（否则模型侧仍看到旧目录） */
  let invalidateSkillCatalog: (() => void) | null = null
  /** 已挂载会话作用域 provider 的会话键 */
  const sessionSkillProviders = new Set<string>()

  const shadowCandidate = (name: string): Record<string, unknown> => ({
    name,
    description: DISABLED_SKILL_DESC,
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'custom',
    provider: SKILL_GATE_PROVIDER,
    rank: SKILL_GATE_RANK,
    locator: { name },
  })
  const shadowDefinition = (candidate: any): Record<string, unknown> => ({
    name: candidate.name,
    description: candidate.description ?? DISABLED_SKILL_DESC,
    invocation: candidate.invocation ?? { modelInvocable: false, userInvocable: false },
    source: candidate.source ?? 'custom',
    provider: candidate.provider ?? SKILL_GATE_PROVIDER,
    content: disabledSkillContent(String(candidate.name)),
  })
  /** 依据禁用集合产出 shadow 候选（非法名跳过，保证 provider 永不让整个目录失败） */
  const shadowCandidatesFor = (names: readonly string[]): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = []
    for (const name of new Set(names)) {
      if (!SKILL_NAME_RE.test(name)) continue
      out.push(shadowCandidate(name))
    }
    return out
  }

  const skillsAny = ctx.skills as any
  const providerCapable = typeof skillsAny?.registerProvider === 'function'

  if (providerCapable) {
    // 全局层 provider：承载 global 默认禁用（全局层参与每条 scope 链 → 全局禁用处处生效）
    ctx.effect(() => {
      let control: any = null
      const dispose = skillsAny.registerProvider((c: any) => {
        control = c
        return {
          name: SKILL_GATE_PROVIDER,
          list: async (): Promise<Array<Record<string, unknown>>> =>
            shadowCandidatesFor(store.global.deniedSkills),
          get: async (candidate: any): Promise<Record<string, unknown>> => shadowDefinition(candidate),
        }
      })
      invalidateSkillCatalog = (): void => {
        try { control?.invalidate?.() } catch { /* ignore */ }
      }
      trace(`skill gate provider registered (official seam, rank=${SKILL_GATE_RANK})`)
      return (): void => {
        invalidateSkillCatalog = null
        try { dispose() } catch { /* ignore */ }
        trace('skill gate provider unregistered')
      }
    }, 'dsh-skillmcp-gate: skill provider')  } else {
    // ── 兜底：旧宿主无 registerProvider → 保留 0.5.x 的 snapshot monkey-patch ──
    // 实测生效机制（0.2.2-rc.5）：agent-loop 把 agent 实例本身当 scope 传入，且 agent 携带 id
    // 字符串 → options.scope.id 命中。注意：这是未文档化实现巧合（ScopeKey 类型是 object），
    // DSH 升级后须回归验证「skill 禁用是否仍按会话过滤」。守卫防双实例重复包装（0.5.1）。
    trace('skills.registerProvider unavailable — falling back to snapshot patch')
    try {
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
          trace('skills.snapshot patched for per-session filtering (legacy fallback)')
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
  }

  /** 会话作用域 provider：让「会话级 skill 禁用」成为可能（官方 seam 的层覆盖语义）。
   *  agent.ctx 即 agent 的作用域 ctx（宿主：calling through agent.ctx scopes EFFECTS），
   *  在其上注入 skills 服务后注册 provider → 落进该 agent 的 scope 层，
   *  读取时近作用域覆盖全局层 → 仅该会话生效。 */
  const ensureSessionSkillProvider = (agent: Agent): void => {
    if (!providerCapable) return
    const sid = normSid(String((agent as any).id ?? (agent as any).sessionId ?? ''))
    if (!sid || sessionSkillProviders.has(sid)) return
    const agentCtx = (agent as any).ctx
    if (!agentCtx || typeof agentCtx.inject !== 'function') return
    try {
      const disposeInject = agentCtx.inject(['skills'], (scoped: any) => {
        const dispose = scoped.skills.registerProvider((c: any) => {
          return {
            name: SKILL_GATE_PROVIDER_SESSION,
            list: async (): Promise<Array<Record<string, unknown>>> => {
              // 会话层 = 该会话「额外禁用」的技能（含全局禁用项；会话 released 已从 effective 中抵消）
              const eff = effective(sid)
              return shadowCandidatesFor(eff.deniedSkills)
            },
            get: async (candidate: any): Promise<Record<string, unknown>> => shadowDefinition(candidate),
          }
        })
        sessionSkillProviders.add(sid)
        trace(`session skill provider mounted for ${sid}`)
        return (): void => {
          try { dispose() } catch { /* ignore */ }
          sessionSkillProviders.delete(sid)
          trace(`session skill provider unmounted for ${sid}`)
        }
      })
      if (typeof disposeInject === 'function') {
        ctx.effect(() => {
          return (): void => {
            try { disposeInject() } catch { /* ignore */ }
            sessionSkillProviders.delete(sid)
          }
        }, 'dsh-skillmcp-gate: session skill provider')
      }
    } catch (e) {
      trace(`session skill provider failed for ${sid}: ${e}`)
    }
  }

  ctx.logger?.info?.(`[${SHORT}] ready — store=${storeFile}${loaded.corrupted ? ' (PREVIOUS FILE QUARANTINED)' : ''}${providerCapable ? ' (skill gate: official provider seam)' : ' (skill gate: legacy snapshot fallback)'}`)
}
