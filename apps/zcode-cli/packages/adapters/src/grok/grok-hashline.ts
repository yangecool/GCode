/**
 * G Code — hashline 锚点方案与编辑核心（M4-b，移植自 grok-harness hashline）。
 *
 * 活默认与 pinned Grok Build 一致：三字母空白归一化局部 FNV-1a 哈希 +
 * 每固定八行 chunk 的三字母指纹（chunk_v1）；content_only 保留为兼容测试
 * 与显式部署。编辑批语义：**原子**——任一 anchor 过期则全部拒绝；结果带
 * 新鲜 anchor 上下文供立即重试。
 *
 * 本模块是纯核心：文件读写经 `HashlineFileIo` 注入；GCode 工具面
 * （hashline_read/hashline_edit/hashline_grep）在其上接线。
 */

// ---------------------------------------------------------------------------
// scheme（scheme.ts 逐行移植）
// ---------------------------------------------------------------------------

const FNV_OFFSET = 2_166_136_261
const FNV_PRIME = 16_777_619
const DEFAULT_HASH_LEN = 3
const DEFAULT_CHUNK_SIZE = 8

export type HashlineSchemeName = 'chunk' | 'content_only'

export interface HashlineSchemeOptions {
  readonly scheme?: HashlineSchemeName
  readonly hashLen?: number
  readonly chunkSize?: number
}

export interface HashlineAnchor {
  readonly line: number
  readonly local: string
  readonly context?: string
}

function resolvedOptions(options: HashlineSchemeOptions = {}): Required<HashlineSchemeOptions> {
  const scheme = options.scheme ?? 'chunk'
  const hashLen = options.hashLen ?? DEFAULT_HASH_LEN
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (!Number.isInteger(hashLen) || hashLen < 1 || hashLen > 4) {
    throw new Error(`hashLen must be an integer in 1..=4, got ${String(hashLen)}`)
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`chunkSize must be a positive integer, got ${String(chunkSize)}`)
  }
  return { scheme, hashLen, chunkSize }
}

function fnvBytes(value: string): number {
  let hash = FNV_OFFSET >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), FNV_PRIME) >>> 0
  }
  return hash
}

/** 单行空白归一化 FNV-1a 32 位指纹。 */
export function lineHash(line: string): number {
  let hash = FNV_OFFSET >>> 0
  let prevWs = false
  const trimmed = line.trim()
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    const ws = code === 32 || code === 9 || code === 10 || code === 13
    if (ws) {
      if (!prevWs) {
        hash = Math.imul(hash ^ 32, FNV_PRIME) >>> 0
        prevWs = true
      }
    } else {
      hash = Math.imul(hash ^ code, FNV_PRIME) >>> 0
      prevWs = false
    }
  }
  return hash
}

/** 32 位哈希编码为小写字母（Grok Build 同形）。 */
export function encodeHash(hash: number, len = DEFAULT_HASH_LEN): string {
  let result = ''
  for (let index = 0; index < len; index += 1) {
    result += String.fromCharCode(((hash >>> (index * 8)) % 26) + 97)
  }
  return result
}

/** 按逻辑行拆分并保留结尾空行。 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return ['']
  return content.split('\n')
}

function chunkFingerprint(
  lines: readonly string[],
  chunkIndex: number,
  hashLen: number,
  chunkSize: number,
): string {
  const start = chunkIndex * chunkSize
  const end = Math.min(lines.length, start + chunkSize)
  let combined = fnvBytes('chunk')
  for (let index = start; index < end; index += 1) {
    combined = Math.imul((combined ^ lineHash(lines[index] ?? '')) >>> 0, FNV_PRIME) >>> 0
  }
  return encodeHash(combined, hashLen)
}

/** 按配置方案为每行生成对齐 anchor。 */
export function generateAnchors(
  lines: readonly string[],
  options: HashlineSchemeOptions = {},
): HashlineAnchor[] {
  const resolved = resolvedOptions(options)
  const contexts = resolved.scheme === 'chunk'
    ? Array.from(
      { length: Math.ceil(lines.length / resolved.chunkSize) },
      (_, index) => chunkFingerprint(lines, index, resolved.hashLen, resolved.chunkSize),
    )
    : undefined
  return lines.map((line, index) => ({
    line: index + 1,
    local: encodeHash(lineHash(line), resolved.hashLen),
    ...contexts === undefined ? {} : { context: contexts[Math.floor(index / resolved.chunkSize)] },
  }))
}

/** 渲染 hashline_edit 接受的完整 anchor。 */
export function renderAnchor(anchor: HashlineAnchor): string {
  return `${String(anchor.line)}:${anchor.local}${anchor.context === undefined ? '' : `:${anchor.context}`}`
}

/** 格式化 `LINE:LOCAL[:CONTEXT]→CONTENT`（hashline_read 输出）。 */
export function formatHashlineRead(
  content: string,
  offset?: number,
  limit?: number,
  options: HashlineSchemeOptions = {},
): string {
  const lines = splitLines(content)
  const anchors = generateAnchors(lines, options)
  const skip = Math.max(0, (offset ?? 1) - 1)
  const take = limit ?? Number.POSITIVE_INFINITY
  return lines.slice(skip, skip + take).map((line, index) => {
    const anchor = anchors[skip + index]
    if (anchor === undefined) throw new Error('hashline anchor generation lost alignment')
    return `${renderAnchor(anchor)}→${line}`
  }).join('\n')
}

/** 解析 `LINE:LOCAL` 或 `LINE:LOCAL:CONTEXT`；畸形输入返回 undefined。 */
export function parseAnchor(raw: string): HashlineAnchor | undefined {
  const match = /^(\d+):([a-z]+)(?::([a-z]+))?$/.exec(raw.trim())
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const line = Number(match[1])
  if (!Number.isSafeInteger(line) || line < 1) return undefined
  return {
    line,
    local: match[2],
    ...match[3] === undefined ? {} : { context: match[3] },
  }
}

/** 完整 anchor 是否仍匹配当前快照。 */
export function anchorMatches(
  anchor: HashlineAnchor,
  lines: readonly string[],
  options: HashlineSchemeOptions = {},
): boolean {
  const generated = generateAnchors(lines, options)[anchor.line - 1]
  if (generated === undefined || generated.local !== anchor.local) return false
  const resolved = resolvedOptions(options)
  if (resolved.scheme === 'chunk') {
    return anchor.context !== undefined && generated.context === anchor.context
  }
  return anchor.context === undefined
}

/** 编辑结果里选中方案的稳定名。 */
export function schemeWireName(options: HashlineSchemeOptions = {}): 'chunk_v1' | 'content_only_v1' {
  return resolvedOptions(options).scheme === 'chunk' ? 'chunk_v1' : 'content_only_v1'
}

// ---------------------------------------------------------------------------
// 编辑核心（index.ts 的纯逻辑段移植；IO 注入）
// ---------------------------------------------------------------------------

const SNIPPET_CONTEXT = 3

interface ReplaceOp {
  op: 'replace'
  anchor: string
  end_anchor?: string
  content: string
}

interface InsertAfterOp {
  op: 'insert_after'
  anchor: string
  content: string
}

interface WriteOp {
  op: 'write'
  content: string
}

export type HashlineOp = ReplaceOp | InsertAfterOp | WriteOp

interface ResolvedOp {
  readonly originalIndex: number
  readonly start: number
  readonly end: number
  readonly newLines: readonly string[]
}

export interface HashlineEditSuccess {
  status: 'ok'
  applied: number
  scheme: 'chunk_v1' | 'content_only_v1'
  snippet_start_line: number
  snippet: string
  absolute_path: string
  warnings: string[]
}

export interface HashlineEditFailure {
  status: 'error'
  error: 'invalid_input' | 'stale_anchor' | 'out_of_range' | 'overlap'
  message: string
  requested_anchor?: string
  current?: string
  context?: string
  context_start_line?: number
  shifted_to?: number
  shifted_anchor?: string
  ambiguous_candidates: number[]
}

export type HashlineEditResult = HashlineEditSuccess | HashlineEditFailure

function editFailure(
  error: HashlineEditFailure['error'],
  message: string,
  extras: Partial<Omit<HashlineEditFailure, 'status' | 'error' | 'message' | 'ambiguous_candidates'>> = {},
): HashlineEditFailure {
  return { status: 'error', error, message, ...extras, ambiguous_candidates: [] }
}

/** 编辑入参归一化（数组/单对象/JSON 字符串均可；write 必须独占）。 */
export function normalizeHashlineEdits(raw: HashlineOp[] | HashlineOp | string): HashlineOp[] {
  let value: unknown = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      throw new Error(`edits was a JSON string but could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0) throw new Error('No edit operations provided.')
  return values.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`edit ${String(index + 1)} must be an object`)
    }
    const record = item as Record<string, unknown>
    if (record['op'] === 'replace') {
      if (typeof record['anchor'] !== 'string' || typeof record['content'] !== 'string') {
        throw new Error(`edit ${String(index + 1)} replace requires string anchor and content`)
      }
      if (record['end_anchor'] !== undefined && typeof record['end_anchor'] !== 'string') {
        throw new Error(`edit ${String(index + 1)} end_anchor must be a string`)
      }
      return {
        op: 'replace', anchor: record['anchor'], content: record['content'],
        ...record['end_anchor'] === undefined ? {} : { end_anchor: record['end_anchor'] },
      }
    }
    if (record['op'] === 'insert_after') {
      if (typeof record['anchor'] !== 'string' || typeof record['content'] !== 'string') {
        throw new Error(`edit ${String(index + 1)} insert_after requires string anchor and content`)
      }
      return { op: 'insert_after', anchor: record['anchor'], content: record['content'] }
    }
    if (record['op'] === 'write') {
      if (typeof record['content'] !== 'string') throw new Error(`edit ${String(index + 1)} write requires string content`)
      return { op: 'write', content: record['content'] }
    }
    throw new Error(`edit ${String(index + 1)} has unknown op ${JSON.stringify(record['op'])}`)
  })
}

function copiedAnchorLine(content: string): number | undefined {
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trimStart()
    const before = trimmed.includes('→') ? trimmed.split('→', 1)[0] : undefined
    if (before !== undefined && before.length <= 25 && /^\d+:[a-z]+(?::[a-z]+)?$/u.test(before)) return index + 1
  }
  return undefined
}

function freshContext(lines: readonly string[], targetIndex: number, scheme: HashlineSchemeOptions): {
  context: string
  context_start_line: number
} {
  const start = Math.max(0, targetIndex - SNIPPET_CONTEXT)
  const end = Math.min(lines.length, targetIndex + SNIPPET_CONTEXT + 1)
  return {
    context: lines.slice(start, end).map((line, offset) => {
      const anchor = generateAnchors(lines, scheme)[start + offset]
      return anchor === undefined ? line : `${renderAnchor(anchor)}→${line}`
    }).join('\n'),
    context_start_line: start + 1,
  }
}

function resolveAnchor(
  raw: string,
  lines: readonly string[],
  scheme: HashlineSchemeOptions,
): number | HashlineEditFailure {
  const anchor = parseAnchor(raw)
  if (anchor === undefined) {
    return editFailure('invalid_input', `Invalid anchor ${JSON.stringify(raw)}; expected LINE:HASH:CONTEXT.`, { requested_anchor: raw })
  }
  if (anchor.line > lines.length) {
    const target = Math.max(0, Math.min(lines.length - 1, anchor.line - 1))
    return editFailure('out_of_range', `Anchor ${raw} points beyond the current ${String(lines.length)} lines.`, {
      requested_anchor: raw,
      ...freshContext(lines, target, scheme),
    })
  }
  if (anchorMatches(anchor, lines, scheme)) return anchor.line - 1
  const all = generateAnchors(lines, scheme)
  const candidates = all.filter(candidate => candidate.local === anchor.local)
  const inRadius = candidates.filter(candidate => Math.abs(candidate.line - anchor.line) <= 15)
  const exact = inRadius.length === 1 ? inRadius[0] : undefined
  return {
    ...editFailure('stale_anchor', `Anchor ${raw} is stale; the file changed since it was read.`, {
      requested_anchor: raw,
      ...lines[anchor.line - 1] === undefined ? {} : { current: lines[anchor.line - 1] },
      ...freshContext(lines, anchor.line - 1, scheme),
      ...exact === undefined ? {} : { shifted_to: exact.line, shifted_anchor: renderAnchor(exact) },
    }),
    ambiguous_candidates: inRadius.length > 1 ? inRadius.map(candidate => candidate.line) : [],
  }
}

function contentLines(content: string, emptyMeansDelete: boolean): string[] {
  if (emptyMeansDelete && content.length === 0) return []
  return content.split('\n')
}

function resolveOperations(
  edits: readonly HashlineOp[],
  lines: readonly string[],
  scheme: HashlineSchemeOptions,
): ResolvedOp[] | HashlineEditFailure {
  const resolved: ResolvedOp[] = []
  for (const [index, edit] of edits.entries()) {
    const copied = copiedAnchorLine(edit.content)
    if (copied !== undefined) {
      return editFailure('invalid_input', `${edit.op} content line ${String(copied)} contains an anchor prefix copied from hashline output; keep only file content.`)
    }
    if (edit.op === 'write') {
      return editFailure('invalid_input', 'A write operation must be the only edit in a batch.')
    }
    if (edit.op === 'insert_after') {
      let point: number
      if (edit.anchor === '0:') point = 0
      else if (edit.anchor === 'EOF') point = lines.length
      else {
        const target = resolveAnchor(edit.anchor, lines, scheme)
        if (typeof target !== 'number') return target
        point = target + 1
      }
      resolved.push({ originalIndex: index, start: point, end: point, newLines: contentLines(edit.content, false) })
      continue
    }
    const start = resolveAnchor(edit.anchor, lines, scheme)
    if (typeof start !== 'number') return start
    const endAnchor = edit.end_anchor
    const endIndex = endAnchor === undefined ? start : resolveAnchor(endAnchor, lines, scheme)
    if (typeof endIndex !== 'number') return endIndex
    if (endIndex < start) {
      return editFailure('invalid_input', `end_anchor line ${String(endIndex + 1)} is before start line ${String(start + 1)}.`, {
        ...endAnchor === undefined ? {} : { requested_anchor: endAnchor },
      })
    }
    resolved.push({ originalIndex: index, start, end: endIndex + 1, newLines: contentLines(edit.content, true) })
  }
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      const a = resolved[left]
      const b = resolved[right]
      if (a === undefined || b === undefined) continue
      const bothInsertSamePoint = a.start === a.end && b.start === b.end && a.start === b.start
      const overlaps = bothInsertSamePoint
        ? false
        : Math.max(a.start, b.start) < Math.min(a.end, b.end)
          || (a.start === a.end && a.start > b.start && a.start < b.end)
          || (b.start === b.end && b.start > a.start && b.start < a.end)
      if (overlaps) return editFailure('overlap', `Edit ${String(left + 1)} overlaps edit ${String(right + 1)}; no edits were applied.`)
    }
  }
  return resolved
}

/**
 * 应用一批编辑（纯函数：内容进出，不碰文件系统）。
 * 任一 anchor 过期/越界/重叠 → 整批拒绝（原子语义）。
 */
export function applyHashlineEdit(
  content: string,
  edits: readonly HashlineOp[],
  path: string,
  scheme: HashlineSchemeOptions = {},
): {
  result: HashlineEditResult
  content?: string
} {
  if (edits.length === 1 && edits[0]?.op === 'write') {
    const next = edits[0].content
    const copied = copiedAnchorLine(next)
    if (copied !== undefined) return { result: editFailure('invalid_input', `write content line ${String(copied)} contains a copied hashline anchor.`) }
    return {
      content: next,
      result: {
        status: 'ok', applied: 1, scheme: schemeWireName(scheme), snippet_start_line: 1,
        snippet: formatHashlineRead(next, 1, 2 * SNIPPET_CONTEXT + 1, scheme),
        absolute_path: path, warnings: [],
      },
    }
  }
  const lines = splitLines(content)
  const resolved = resolveOperations(edits, lines, scheme)
  if (!Array.isArray(resolved)) return { result: resolved }
  const ordered = [...resolved].sort((left, right) => right.start - left.start || right.originalIndex - left.originalIndex)
  const nextLines = [...lines]
  for (const edit of ordered) nextLines.splice(edit.start, edit.end - edit.start, ...edit.newLines)
  const next = nextLines.join('\n')
  const firstStart = Math.min(...resolved.map(edit => edit.start))
  const snippetStart = Math.max(0, firstStart - SNIPPET_CONTEXT)
  const inserted = Math.max(...resolved.map(edit => edit.newLines.length), 1)
  const snippetLimit = Math.min(splitLines(next).length - snippetStart, inserted + 2 * SNIPPET_CONTEXT)
  const warnings = resolved.flatMap(edit => edit.end - edit.start > 50
    ? [`Caution: edit ${String(edit.originalIndex + 1)} rewrote ${String(edit.end - edit.start)} lines.`]
    : [])
  return {
    content: next,
    result: {
      status: 'ok', applied: edits.length, scheme: schemeWireName(scheme),
      snippet_start_line: snippetStart + 1,
      snippet: formatHashlineRead(next, snippetStart + 1, snippetLimit, scheme),
      absolute_path: path, warnings,
    },
  }
}

// ---------------------------------------------------------------------------
// 工具面 IO 接缝（GCode 工具接线点）
// ---------------------------------------------------------------------------

/** hashline 工具的文件系统接缝。 */
export interface HashlineFileIo {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
}

/**
 * hashline_edit 工具主体：读取-应用-写回。
 * 失败结果不写文件（原子语义由 applyHashlineEdit 保证）。
 */
export async function runHashlineEdit(
  io: HashlineFileIo,
  args: { file_path: string; edits: HashlineOp[] | HashlineOp | string },
  scheme: HashlineSchemeOptions = {},
): Promise<HashlineEditResult> {
  const edits = normalizeHashlineEdits(args.edits)
  const content = await io.read(args.file_path)
  const { result, content: next } = applyHashlineEdit(content, edits, args.file_path, scheme)
  if (result.status === 'ok' && next !== undefined) {
    await io.write(args.file_path, next)
  }
  return result
}
