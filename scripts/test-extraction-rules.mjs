import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(join(tmpdir(), 'ppocr-extract-rules-'))
const entry = join(directory, 'test.ts')
const output = join(directory, 'test.mjs')

try {
  await writeFile(
    entry,
    `
      import { strict as assert } from 'node:assert'
      import {
        bumpInvoiceNoCount,
        mergeAirWaybillByMajorityInvoiceNo,
        normalizeInvoiceNo,
        pickMajorityInvoiceNo,
      } from '${process.cwd()}/src/utils/invoiceMerge.ts'
      import { fieldValuesEqual } from '${process.cwd()}/src/utils/accuracyStats.ts'

      assert.equal(normalizeInvoiceNo(' hkgir 02836829 '), 'HKGIR02836829')

      const counts = new Map()
      bumpInvoiceNoCount(counts, '9-522-83357')
      bumpInvoiceNoCount(counts, '9-522-83357')
      bumpInvoiceNoCount(counts, '9-522-8335Z') // OCR 错号，只出现 1 次
      bumpInvoiceNoCount(counts, '9-522-83357')
      assert.equal(pickMajorityInvoiceNo(counts), '9-522-83357')

      // FedEx/DHL：子清单全部归到出现最多的发票号，其余发票号视为识别错误
      const merged = mergeAirWaybillByMajorityInvoiceNo(
        [
          {
            header: { invoice_no: '9-522-83357', invoice_date: '13 Nov 2025' },
            sublist: [{ air_waybill_number: '111', total: '10.00' }],
          },
          {
            header: { invoice_no: '9-522-8335Z', invoice_date: '' },
            sublist: [{ air_waybill_number: '222', total: '20.00' }],
          },
          {
            header: { invoice_no: '9-522-83357', invoice_date: '' },
            sublist: [{ air_waybill_number: '333', total: '30.00' }],
          },
        ],
        'invoice_no',
        counts,
      )
      assert.equal(merged.length, 1)
      assert.equal(merged[0].header.invoice_no, '9-522-83357')
      assert.equal(merged[0].header.invoice_date, '13 Nov 2025')
      assert.equal(merged[0].sublist.length, 3)

      // 次数并列时取先出现的发票号
      const tieCounts = new Map([
        ['AAA111', 2],
        ['BBB222', 2],
      ])
      assert.equal(pickMajorityInvoiceNo(tieCounts), 'AAA111')

      // 准确率：逗号/短横规则（与主测试互补）
      assert.equal(fieldValuesEqual('incoterm', 'FOB—Free On Board', 'FOB - Free On Board'), true)
    `,
  )
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
  })
  await import(pathToFileURL(output).href)
  console.log('Extraction rules tests passed')
} finally {
  await rm(directory, { recursive: true, force: true })
}
