import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(join(tmpdir(), 'ppocr-llm-test-'))
const entry = join(directory, 'test.ts')
const output = join(directory, 'test.mjs')

try {
  await writeFile(
    entry,
    `
      import { strict as assert } from 'node:assert'
      import { chatWithLlm, LlmOutputError } from '${process.cwd()}/src/api/llm.ts'
      import {
        parseClassification,
        shouldSkipPage,
      } from '${process.cwd()}/src/utils/llmClassification.ts'
      import {
        buildPageRequestBody,
        parseRequestJson,
      } from '${process.cwd()}/src/utils/llmConfig.ts'

      const classification = parseClassification(
        '{"is_target":false,"confidence":0.92,"reason":"版式不符"}',
      )
      assert.equal(shouldSkipPage(classification, 0.8), true)
      assert.equal(
        shouldSkipPage({ ...classification, confidence: 0.6 }, 0.8),
        false,
      )

      const request = JSON.stringify({
        model: 'qwen3-vl',
        options: { temperature: 0 },
        messages: [
          { role: 'user', content: 'extract', images: ['{{PAGE_IMAGE}}'] },
        ],
      })
      assert.equal(parseRequestJson(request).error, null)
      const body = buildPageRequestBody(request, 'base64-image')
      assert.deepEqual(body.options, { temperature: 0 })
      assert.deepEqual(body.messages[0].images, ['base64-image'])

      globalThis.fetch = async () =>
        new Response('{"message":{},"done":true}\\n', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      await assert.rejects(
        () => chatWithLlm({ model: 'qwen3-vl', messages: [] }),
        LlmOutputError,
      )
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
  assert.ok(true)
  console.log('LLM workflow tests passed')
} finally {
  await rm(directory, { recursive: true, force: true })
}
