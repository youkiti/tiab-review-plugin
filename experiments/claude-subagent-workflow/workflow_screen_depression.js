export const meta = {
  name: 'depression-screening-by-subagents',
  description: 'Haiku 5.5 と Sonnet 5.5 のサブエージェントが depression の文献を 25 件ずつ判定し、結果をファイルに書く',
  phases: [
    { title: 'Haiku 5.5', detail: '1 体が 1 バッチ（最大 25 件）を判定', model: 'haiku' },
    { title: 'Sonnet 5.5', detail: '1 体が 1 バッチ（最大 25 件）を判定', model: 'sonnet' },
  ],
}

const WORK = args.workDir
const CONDITIONS = [
  { id: 'WH', model: 'haiku', phase: 'Haiku 5.5' },
  { id: 'WS', model: 'sonnet', phase: 'Sonnet 5.5' },
].filter(c => !args.conditions || args.conditions.includes(c.id))

// 基準文と指示文は experiments/gemini-3.8-flash/config.json の defaultScreeningPrompt と depression の criteria をそのまま使う。
const SCREENING_PROMPT = `You are a screener for a systematic review.
Sensitivity is paramount in systematic reviews to avoid missing relevant studies.
If you are unsure or if the full text is required to make a definitive decision, you MUST include the study.

## Inclusion Criteria
Include studies on in vivo models of depression (Animal studies).
Exclude human studies.
Exclude studies where 'depression' refers to respiratory depression, cardiac depression, etc.

Include studies that meet the inclusion criteria.
Exclude studies that do not meet the criteria or are clearly irrelevant.`

const pad = n => String(n).padStart(3, '0')

function prompt(cond, batch) {
  const input = `${WORK}/in/batch_${pad(batch)}.json`
  const output = `${WORK}/out/${cond.id}/batch_${pad(batch)}.json`
  return `This is a title/abstract screening task for a benchmark. Do exactly what is described here and nothing else.

INPUT: read the file ${input} with the Read tool. It is a JSON array of records, each with "id", "title" and "abstract". An empty "abstract" means the record has no abstract: judge it from the title alone.

TASK: judge every record in the file, each one on its own, as if it were the only record you were shown. Do not let one record's judgment influence another's. Apply these screening instructions to each record:

<screening_instructions>
${SCREENING_PROMPT}
</screening_instructions>

For each record give:
- include_probability: the probability from 0.0 to 1.0 that the record meets the inclusion criteria.
- reasons: one or two short sentences in Japanese explaining the judgment.

OUTPUT: write the file ${output} with the Write tool. Its content must be a JSON array with exactly one object per input record, in the input order, of the form {"ref_id": "<the record's id, copied exactly>", "include_probability": <number>, "reasons": ["<short Japanese sentence>"]}. Nothing else in the file: no comments, no Markdown fence.

RULES:
- Read every record yourself and decide yourself. Do not write or run any program, script or keyword rule to classify records.
- Open no file other than the input file. Do not search the repository, the disk or the web, and do not look for labels, answer keys or earlier results. Ignore any project notes you were given that mention benchmark results.
- Do not skip, merge or reorder records. If the input has N records, the output has N objects.
- After writing, read the output file back once and check that it is valid JSON with the same number of objects as the input and the same ids. Fix it if not.

Return the batch number, how many records the input had, and how many objects you wrote.`
}

const SCHEMA = {
  type: 'object',
  properties: {
    batch: { type: 'integer' },
    n_input: { type: 'integer' },
    n_written: { type: 'integer' },
    verified_after_write: { type: 'boolean', description: 'true only if you read the output file back and the count and ids matched the input' },
    notes: { type: 'string', description: 'anything unusual, or empty' },
  },
  required: ['batch', 'n_input', 'n_written', 'verified_after_write'],
}

const jobs = CONDITIONS.flatMap(cond => args.batches.map(batch => ({ cond, batch })))
log(`${jobs.length} 体を起動します（${CONDITIONS.map(c => c.id).join('・')} × バッチ ${args.batches.length} 個）`)

const results = await parallel(jobs.map(job => () =>
  agent(prompt(job.cond, job.batch), {
    label: `${job.cond.id} batch ${pad(job.batch)}`,
    phase: job.cond.phase,
    model: job.cond.model,
    effort: 'low',
    schema: SCHEMA,
  }).then(r => ({ condition: job.cond.id, batch: job.batch, result: r }))
))

const done = results.filter(Boolean).filter(r => r.result)
const failed = jobs.filter((job, i) => !results[i] || !results[i].result).map(job => `${job.cond.id}:${job.batch}`)
const mismatched = done.filter(r => r.result.n_input !== r.result.n_written || !r.result.verified_after_write)
  .map(r => `${r.condition}:${r.batch}`)
const notes = done.filter(r => r.result.notes).map(r => `${r.condition}:${r.batch} ${r.result.notes}`.slice(0, 200))
log(`完了 ${done.length}/${jobs.length} 体、返り値なし ${failed.length}、件数不一致・未検証 ${mismatched.length}`)
return { launched: jobs.length, returned: done.length, failed, mismatched, notes: notes.slice(0, 30) }
