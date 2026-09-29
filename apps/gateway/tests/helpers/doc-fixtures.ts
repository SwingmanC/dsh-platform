/**
 * K-T1 测试 fixture 构造器:程序化生成最小有效 PDF / DOCX(无外部依赖、无二进制入库)。
 */

/** 构造最小有效 PDF(1 页,Helvetica 文本层;xref 偏移程序化计算)。 */
export function buildMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1')
  const contentStream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = out.length
  out += `xref\n0 ${objects.length + 1}\n`
  out += '0000000000 65535 f \n'
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

// --- DOCX:手工构造 stored(不压缩)ZIP,自含 CRC32 ---

const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry { name: string; data: Buffer }

/** 组装 stored ZIP(local header + central directory + EOCD,全部 method=0)。 */
function buildStoredZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, e.data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(e.data.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + e.data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 构造最小有效 DOCX(仅 document.xml + 必要 rels;mammoth 可读)。 */
export function buildMinimalDocx(paragraphText: string): Buffer {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const docXml = `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(paragraphText)}</w:t></w:r></w:p></w:body></w:document>`
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: Buffer.from(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    },
    { name: 'word/document.xml', data: Buffer.from(docXml) },
  ]
  return buildStoredZip(entries)
}
