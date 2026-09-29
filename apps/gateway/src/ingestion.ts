import { createHash } from 'node:crypto'
import { config } from './config.js'

const MAX_TEXT_SIZE = 10 * 1024 * 1024
export const KNOWLEDGE_MAX_TEXT_BYTES = MAX_TEXT_SIZE
export const DEFAULT_CHUNK_SIZE = 800
export const DEFAULT_CHUNK_OVERLAP = 120

export function extractText(buffer: Buffer, mime: string): string {
  if (buffer.length > MAX_TEXT_SIZE) throw new Error('document-too-large')
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/x-markdown') {
    return normalizeExtractedText(buffer.toString('utf8'))
  }
  throw new Error(`unsupported-mime: ${mime}`)
}

/** 复用既有清洗规则:去 NUL/控制字符(供 PDF/DOCX 提取结果走同一条规范化路径)。 */
function normalizeExtractedText(text: string): string {
  return text.replace(/\0/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** 文本清洗 + 大小上限(与 extractText 同规则)。 */
function finalizeExtractedText(text: string): string {
  const normalized = normalizeExtractedText(text)
  if (normalized.length > MAX_TEXT_SIZE) throw new Error('document-too-large')
  return normalized
}

/**
 * K-T1:解析 dispatcher(异步;PDF/DOCX 走各自解析器,文本类型沿用 extractText)。
 * 所有失败均为受控错误码,不含 stack/路径/secret:
 *   document-too-large | unsupported-mime: <mime> |
 *   pdf-parse-failed | pdf-no-extractable-text |
 *   docx-parse-failed | docx-no-extractable-text
 */
export async function extractTextFromBuffer(buffer: Buffer, mime: string): Promise<string> {
  if (buffer.length > MAX_TEXT_SIZE) throw new Error('document-too-large')
  if (mime === 'application/pdf') return parsePdfText(buffer)
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return parseDocxText(buffer)
  return extractText(buffer, mime)
}

interface PdfjsTextItem { str?: unknown }
interface PdfjsPage { getTextContent(): Promise<{ items: readonly PdfjsTextItem[] }> }
interface PdfjsDocument { numPages: number; getPage(n: number): Promise<PdfjsPage>; destroy?(): Promise<void> }

async function parsePdfText(buffer: Buffer): Promise<string> {
  let doc: PdfjsDocument
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(src: { data: Uint8Array; verbosity: number; isEvalSupported: boolean }): { promise: Promise<PdfjsDocument> }
    }
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
      isEvalSupported: false,
    }).promise
  } catch {
    throw new Error('pdf-parse-failed')
  }
  try {
    let text = ''
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      text += content.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' ') + '\n'
    }
    const finalized = finalizeExtractedText(text).trim()
    if (finalized === '') throw new Error('pdf-no-extractable-text')
    return finalized
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('pdf-')) throw err
    throw new Error('pdf-parse-failed')
  } finally {
    void doc.destroy?.()?.catch(() => undefined)
  }
}

async function parseDocxText(buffer: Buffer): Promise<string> {
  let text: string
  try {
    const mammoth = (await import('mammoth')) as unknown as {
      extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>
    }
    const result = await mammoth.extractRawText({ buffer })
    text = result.value
  } catch {
    throw new Error('docx-parse-failed')
  }
  const finalized = finalizeExtractedText(text).trim()
  if (finalized === '') throw new Error('docx-no-extractable-text')
  return finalized
}

export interface Chunk {
  index: number
  content: string
  textHash: string
  sourceOffset: number
}

/**
 * 解析并守卫分块参数(K-T2-lite):
 * - maxSize 未指定/非正/非有限 → 回退默认 800;
 * - overlap 未指定(undefined)→ 默认 120;显式 0 合法(无重叠);负数 → 0;
 * - overlap ≥ maxSize → 双双回退默认(800/120)。
 * 保证 step = maxSize - overlap ≥ 1,杜绝死循环/空 chunk。
 */
export function resolveChunkParams(maxSize?: number, overlap?: number): { size: number; overlap: number } {
  let size = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize > 0
    ? Math.floor(maxSize)
    : DEFAULT_CHUNK_SIZE
  let ov = overlap === undefined
    ? DEFAULT_CHUNK_OVERLAP
    : (Number.isFinite(overlap) && overlap > 0 ? Math.floor(overlap) : 0)
  if (ov >= size) {
    size = DEFAULT_CHUNK_SIZE
    ov = DEFAULT_CHUNK_OVERLAP
  }
  return { size, overlap: ov }
}

/**
 * 分块(K-T2-lite):段落优先 + Markdown 标题感知(保持既有行为),
 * 超长单段落按滑动窗硬切,相邻窗口重叠 `overlap` 字符;段落聚合块之间
 * 以段落边界为界,不制造人工重叠。单位为字符(不引入 tokenizer)。
 */
export function chunkDocument(
  text: string,
  maxSize: number = config.knowledge.chunkSize,
  overlap: number = config.knowledge.chunkOverlap,
): Chunk[] {
  if (text.length === 0) return []
  const { size, overlap: ov } = resolveChunkParams(maxSize, overlap)
  const result: Chunk[] = []
  const push = (content: string, start: number): void => {
    if (content.trim() === '') return
    result.push(makeChunk(content, result.length, start))
  }

  let current = ''
  let currentStart = 0
  for (const para of splitIntoParagraphsWithOffsets(text)) {
    if (para.text.trim() === '') continue
    if (para.text.length > size) {
      // 超长单段落:先落已聚合内容,再滑动窗硬切(窗口 ≤ size,相邻重叠 ov)。
      push(current, currentStart)
      current = ''
      const step = size - ov
      for (let i = 0; i < para.text.length; i += step) {
        push(para.text.slice(i, i + size), para.start + i)
        if (i + size >= para.text.length) break
      }
      continue
    }
    if (current === '') {
      current = para.text
      currentStart = para.start
    } else if (current.length + 2 + para.text.length <= size) {
      current += '\n\n' + para.text
    } else {
      push(current, currentStart)
      current = para.text
      currentStart = para.start
    }
  }
  push(current, currentStart)
  return result
}

interface ParagraphSlice {
  text: string
  /** 段落在原文中的起始偏移(供 sourceOffset/溯源使用)。 */
  start: number
}

/** 段落切分:空行分段;`#` 标题行强制开启新段(保持既有标题感知行为)。 */
function splitIntoParagraphsWithOffsets(text: string): ParagraphSlice[] {
  const result: ParagraphSlice[] = []
  let current = ''
  let currentStart = 0
  let offset = 0
  for (const line of text.split('\n')) {
    const lineStart = offset
    offset += line.length + 1 // '\n'
    if (line.trim() === '' && current) {
      result.push({ text: current, start: currentStart })
      current = ''
    } else if (line.startsWith('#') && current) {
      result.push({ text: current, start: currentStart })
      current = line
      currentStart = lineStart
    } else if (current === '') {
      current = line
      currentStart = lineStart
    } else {
      current += '\n' + line
    }
  }
  if (current) result.push({ text: current, start: currentStart })
  return result
}

function makeChunk(content: string, index: number, offset: number): Chunk {
  return {
    index,
    content,
    textHash: createHash('sha256').update(content).digest('hex').slice(0, 16),
    sourceOffset: offset,
  }
}
