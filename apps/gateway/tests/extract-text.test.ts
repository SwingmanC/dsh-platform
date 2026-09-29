/**
 * K-T1 单测:PDF/DOCX 解析 dispatcher + 回归 + 失败路径。
 * 纯函数级测试(fixtures 程序化生成),无 DB/网络/服务依赖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractTextFromBuffer, chunkDocument } from '../src/ingestion.js'
import { buildMinimalPdf, buildMinimalDocx } from './helpers/doc-fixtures.js'

test('Case 1: TXT 解析回归(原行为不变)', async () => {
  const text = await extractTextFromBuffer(Buffer.from('Hello\nWorld', 'utf8'), 'text/plain')
  assert.ok(text.includes('Hello') && text.includes('World'))
})

test('Case 2: Markdown 解析回归(标题感知保留)', async () => {
  const text = await extractTextFromBuffer(Buffer.from('# Title\n\nbody text', 'utf8'), 'text/markdown')
  assert.ok(text.includes('# Title') && text.includes('body text'))
  // maxSize=15:7+2+9=18 超限 → 标题块与正文块按边界分离
  const chunks = chunkDocument(text, 15, 0)
  assert.equal(chunks[0]!.content, '# Title')
  assert.equal(chunks[1]!.content, 'body text')
})

test('Case 3: PDF 文本层提取(含 marker)', async () => {
  const buf = buildMinimalPdf('CMCC_PDF_KNOWLEDGE_TEST')
  const text = await extractTextFromBuffer(buf, 'application/pdf')
  assert.ok(text.includes('CMCC_PDF_KNOWLEDGE_TEST'), `actual: ${text.slice(0, 120)}`)
})

test('Case 4: DOCX 文本提取(含 marker)', async () => {
  const buf = buildMinimalDocx('CMCC_DOCX_KNOWLEDGE_TEST')
  const text = await extractTextFromBuffer(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.ok(text.includes('CMCC_DOCX_KNOWLEDGE_TEST'), `actual: ${text.slice(0, 120)}`)
})

test('Case 5: 损坏 PDF → 结构化失败(pdf-parse-failed)', async () => {
  await assert.rejects(
    extractTextFromBuffer(Buffer.from('this is definitely not a pdf at all 12345', 'utf8'), 'application/pdf'),
    /pdf-parse-failed/,
  )
})

test('Case 6: 损坏 DOCX → 结构化失败(docx-parse-failed)', async () => {
  await assert.rejects(
    extractTextFromBuffer(Buffer.from('this is definitely not a zip at all 12345', 'utf8'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    /docx-parse-failed/,
  )
})

test('Case 7: 不允许的 MIME → unsupported-mime', async () => {
  await assert.rejects(
    extractTextFromBuffer(Buffer.from('MZ fake exe', 'utf8'), 'application/x-msdownload'),
    /unsupported-mime: application\/x-msdownload/,
  )
})

test('Case 8: 超过 10MB → document-too-large(不进入解析)', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)
  await assert.rejects(extractTextFromBuffer(big, 'text/plain'), /document-too-large/)
})

test('Case 9: 无文本层 PDF → pdf-no-extractable-text(不生成空文档)', async () => {
  const buf = buildMinimalPdf('')
  await assert.rejects(extractTextFromBuffer(buf, 'application/pdf'), /pdf-no-extractable-text/)
})

test('K-T1 集成点:PDF 提取文本进入既有 chunkDocument(LIKE 检索数据源)', async () => {
  const text = await extractTextFromBuffer(buildMinimalPdf('CMCC_PDF_KNOWLEDGE_TEST'), 'application/pdf')
  const chunks = chunkDocument(text, 800, 120)
  assert.ok(chunks.length >= 1)
  assert.ok(chunks.some((c) => c.content.includes('CMCC_PDF_KNOWLEDGE_TEST')))
})
