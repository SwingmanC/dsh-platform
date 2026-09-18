import { createHash } from 'node:crypto'

const MAX_TEXT_SIZE = 10 * 1024 * 1024
const DEFAULT_CHUNK_SIZE = 2048
const OVERLAP_SIZE = 128

export function extractText(buffer: Buffer, mime: string): string {
  if (buffer.length > MAX_TEXT_SIZE) throw new Error('document-too-large')
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/x-markdown') {
    let text = buffer.toString('utf8')
    text = text.replace(/\0/g, '')
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    return text
  }
  throw new Error(`unsupported-mime: ${mime}`)
}

export interface Chunk {
  index: number
  content: string
  textHash: string
  sourceOffset: number
}

export function chunkDocument(text: string, maxSize = DEFAULT_CHUNK_SIZE, overlap = OVERLAP_SIZE): Chunk[] {
  if (text.length === 0) return []
  const chunks: Chunk[] = []
  const paragraphs = splitIntoParagraphs(text)
  let current = ''
  let offset = 0
  let index = 0

  for (const para of paragraphs) {
    if ((current + para).length <= maxSize || current === '') {
      current += (current ? '\n\n' : '') + para
    } else {
      chunks.push(makeChunk(current, index, offset))
      index++
      offset += current.length - overlap
      current = text.slice(offset, offset + maxSize)
    }
  }
  if (current) chunks.push(makeChunk(current, index, offset))
  return chunks
}

function splitIntoParagraphs(text: string): string[] {
  const result: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    if (line.trim() === '' && current) {
      result.push(current)
      current = ''
    } else if (line.startsWith('#') && current) {
      result.push(current)
      current = line
    } else {
      current += (current ? '\n' : '') + line
    }
  }
  if (current) result.push(current)
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