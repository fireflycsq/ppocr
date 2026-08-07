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
        editDistance,
        mergeDhlInvoicesByInvoiceNo,
      } from '${process.cwd()}/src/utils/invoiceMerge.ts'
      import { fieldValuesEqual } from '${process.cwd()}/src/utils/accuracyStats.ts'

      assert.equal(editDistance('HKGIR02836829', 'HKGIR02836829'), 0)
      assert.equal(editDistance('HKGIR02836829', 'HKGIR02836828'), 1)
      assert.equal(editDistance('HKGIR02836829', 'HKGIR0283682'), 1)
      assert.equal(editDistance('HKGIR02836829', 'HKGIR02836800'), 2)
      assert.ok(editDistance('HKGIR02836829', 'XXXXXXXXXXXXX') > 1)

      // DHL：编辑距离 ≤ 1 的发票合并到 13 位发票号下
      const merged = mergeDhlInvoicesByInvoiceNo(
        [
          {
            header: { invoice_no: 'HKGIR0283682', invoice_date: '30/11/2025' },
            sublist: [{ air_waybill_number: '111', total: '10.00' }],
          },
          {
            header: { invoice_no: 'HKGIR02836829', invoice_date: '' },
            sublist: [{ air_waybill_number: '222', total: '20.00' }],
          },
          {
            header: { invoice_no: 'OTHERINVOICE01', invoice_date: '01/01/2025' },
            sublist: [{ air_waybill_number: '333', total: '30.00' }],
          },
        ],
        'invoice_no',
      )
      assert.equal(merged.length, 2)
      const dhl = merged.find((inv) => inv.header.invoice_no === 'HKGIR02836829')
      assert.ok(dhl)
      assert.equal(dhl.header.invoice_date, '30/11/2025')
      assert.equal(dhl.sublist.length, 2)
      assert.equal(
        merged.find((inv) => inv.header.invoice_no === 'OTHERINVOICE01')?.sublist.length,
        1,
      )

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
