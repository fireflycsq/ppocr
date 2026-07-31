import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(join(tmpdir(), 'ppocr-accuracy-test-'))
const entry = join(directory, 'test.ts')
const output = join(directory, 'test.mjs')

try {
  await writeFile(
    entry,
    `
      import { strict as assert } from 'node:assert'
      import {
        buildAccuracyReport,
        fieldValuesEqual,
        fileMatchKey,
        parseExportJson,
      } from '${process.cwd()}/src/utils/accuracyStats.ts'

      // 文件名配对：目录/后缀/大小写不敏感
      assert.equal(fileMatchKey('结果/A发票.json'), fileMatchKey('答案/A发票.PDF'))

      // 金额字段数值比对；文本字段空白归一
      assert.equal(fieldValuesEqual('total', 'HKD 1,500.00', '1500.00'), true)
      assert.equal(fieldValuesEqual('invoice_no', ' 9-522-83357 ', '9-522-83357'), true)
      assert.equal(fieldValuesEqual('invoice_no', '123', '124'), false)

      // 单文档导出（发票+子清单）
      const answerJson = JSON.stringify({
        fileName: 'fedex-a.pdf',
        structureType: 'invoice_with_sublist',
        invoice: { invoice_no: '9-522-83357', invoice_date: '13 Nov 2025' },
        sublist: [
          { air_waybill_number: '444760470550', total: '21.38' },
          { air_waybill_number: '444760472792', total: '17.09' },
          { air_waybill_number: '444760472807', total: '14.99' },
        ],
      })
      const resultJson = JSON.stringify({
        fileName: 'fedex-a.pdf',
        structureType: 'invoice_with_sublist',
        invoice: { invoice_no: '9-522-83357', invoice_date: '13 Nov 2025' },
        sublist: [
          { air_waybill_number: '444760470550', total: '21.38' },
          { air_waybill_number: '444760472792', total: '17.90' }, // 金额错
        ], // 第三行漏识别
        extraction: { layoutTemplateId: 'air_waybill' },
      })
      const answers = parseExportJson(answerJson, 'fedex-a.json')
      const results = parseExportJson(resultJson, 'fedex-a.json')

      // 再加一对全对的 GEODIS 文档（批量导出格式）
      const geodisBatch = JSON.stringify({
        documents: [
          {
            fileName: 'geodis-b.pdf',
            structureType: 'invoice_with_sublist',
            invoice: {
              invoice_no: 'GHK01256555',
              invoice_date: '18-Feb-25',
              supplier: 'GEODIS Hong Kong Limited',
              total_hkd: '3,597.88',
            },
            sublist: [
              { description: 'Bill of Lading Fee', charges_in_hkd: '650.00' },
            ],
          },
        ],
      })
      const geodisResult = JSON.stringify({
        fileName: 'geodis-b.pdf',
        structureType: 'invoice_with_sublist',
        invoice: {
          invoice_no: 'GHK01256555',
          invoice_date: '18-Feb-25',
          supplier: 'GEODIS Hong Kong Limited',
          total_hkd: '3597.88',
        },
        sublist: [{ description: 'Bill of Lading Fee', charges_in_hkd: '650.00' }],
        extraction: { layoutTemplateId: 'freight_invoice' },
      })
      answers.push(...parseExportJson(geodisBatch, 'batch.json'))
      results.push(...parseExportJson(geodisResult, 'geodis-b.json'))

      // 一个只有答案没有结果的文件
      answers.push(
        ...parseExportJson(
          JSON.stringify({
            fileName: 'orphan.pdf',
            fields: { invoice_no: 'X1' },
          }),
          'orphan.json',
        ),
      )

      const report = buildAccuracyReport(answers, results)

      assert.equal(report.matchedPairs, 2)
      assert.equal(report.docAllCorrect, 1) // GEODIS 全对（金额数值等价）
      assert.deepEqual(report.unmatchedAnswers, ['orphan.pdf'])
      assert.equal(report.unmatchedResults.length, 0)

      const fedex = report.templates.find((t) => t.templateId === 'air_waybill')
      assert.ok(fedex)
      assert.equal(fedex.docTotal, 1)
      assert.equal(fedex.docAllCorrect, 0)
      // 发票头 2 字段全对
      for (const stat of fedex.headerFieldStats) {
        assert.equal(stat.correct, stat.total)
      }
      // 明细：3 行答案，1 行漏识别；total 列 1 对 2 错（金额错 + 漏行）
      assert.equal(fedex.answerRows, 3)
      assert.equal(fedex.missingRows, 1)
      const totalStat = fedex.sublistFieldStats.find((s) => s.key === 'total')
      assert.equal(totalStat.total, 3)
      assert.equal(totalStat.correct, 1)
      const awbStat = fedex.sublistFieldStats.find(
        (s) => s.key === 'air_waybill_number',
      )
      assert.equal(awbStat.correct, 2)

      // 错误样本列表
      assert.equal(fedex.errorDocs.length, 1)
      assert.equal(fedex.errorDocs[0].fileName, 'fedex-a.pdf')
      const kinds = fedex.errorDocs[0].errors.map((e) => e.kind)
      assert.ok(kinds.includes('field_mismatch'))
      assert.ok(kinds.includes('missing_row'))

      const geodis = report.templates.find((t) => t.templateId === 'freight_invoice')
      assert.ok(geodis)
      assert.equal(geodis.docAllCorrect, 1)
      assert.equal(geodis.errorDocs.length, 0)
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
  console.log('Accuracy stats tests passed')
} finally {
  await rm(directory, { recursive: true, force: true })
}
