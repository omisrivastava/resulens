import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
}

type AnalyzeRequest = {
  id?: string
  fileName?: string
  resumeText?: string
  jdText?: string
}

type AnalysisResult = {
  id: string
  createdAt: string
  fileName: string
  jobWords: number
  tokenEstimate: number
  fitScore: number
  matchedSkills: string[]
  missingSkills: string[]
  gapNarrative: string
  rewrites: Array<{ before: string; after: string }>
  modelUsed: string
}

type SkillRow = {
  skill: string
  status: 'Matched' | 'Missing' | 'Partial'
  evidence: string
}

const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions'
const fallbackModel = 'minimax/minimax-m2.5:free'

const app = new Hono<{ Bindings: Bindings }>()
const memoryStore = new Map<string, AnalysisResult>()

app.use('/api/*', cors())

app.get('/', (c) => {
  return c.text('ResuLens Worker is running')
})

app.post('/api/upload', async (c) => {
  const body = await c.req.json<AnalyzeRequest>()
  const id = body.id ?? crypto.randomUUID()

  return c.json({
    id,
    status: 'pending',
    objectKey: `resumes/${id}/${sanitizeFileName(body.fileName ?? 'resume.pdf')}`,
    uploadUrl: null,
    note: 'R2 presigned upload is stubbed until bucket credentials are configured.',
  })
})

app.post('/api/analyze', async (c) => {
  const body = await c.req.json<AnalyzeRequest>()
  const id = body.id ?? crypto.randomUUID()
  const fileName = body.fileName ?? 'resume.pdf'
  const resumeText = body.resumeText ?? ''
  const jdText = body.jdText ?? ''

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      try {
        if (!c.env.OPENROUTER_API_KEY) {
          throw new Error('OPENROUTER_API_KEY is not configured.')
        }

        const result = await runOpenRouterAnalysis({
          apiKey: c.env.OPENROUTER_API_KEY,
          model: c.env.OPENROUTER_MODEL ?? fallbackModel,
          id,
          fileName,
          resumeText,
          jdText,
          onToken: (text) => send('token', { text }),
        })

        memoryStore.set(id, result)
        send('skills', rowsFromResult(result))
        send('complete', result)
      } catch (error) {
        const result = buildMockResult({
          id,
          fileName,
          resumeText,
          jdText,
          modelUsed: `mock fallback after ${error instanceof Error ? error.message : 'OpenRouter error'}`,
        })

        send('skills', rowsFromResult(result))
        await sleep(250)

        for (const text of chunkText(result.gapNarrative)) {
          send('token', { text })
          await sleep(60)
        }

        memoryStore.set(id, result)
        send('complete', result)
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
    },
  })
})

app.get('/api/result/:id', (c) => {
  const result = memoryStore.get(c.req.param('id'))
  if (!result) return c.json({ error: 'Result not found' }, 404)
  return c.json(result)
})

app.delete('/api/result/:id', (c) => {
  const deleted = memoryStore.delete(c.req.param('id'))
  return c.json({ deleted })
})

app.get('/api/history', (c) => {
  return c.json({
    analyses: Array.from(memoryStore.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  })
})

app.delete('/api/history', (c) => {
  memoryStore.clear()
  return c.json({ deleted: true })
})

app.get('/api/export/:id', (c) => {
  const result = memoryStore.get(c.req.param('id'))
  if (!result) return c.text('Result not found', 404)

  const markdown = [
    `# ResuLens analysis: ${result.fileName}`,
    '',
    `Fit score: ${result.fitScore}/100`,
    `Model mix: ${result.modelUsed}`,
    '',
    '## Matched skills',
    ...result.matchedSkills.map((skill) => `- ${skill}`),
    '',
    '## Missing skills',
    ...result.missingSkills.map((skill) => `- ${skill}`),
    '',
    '## Gap narrative',
    result.gapNarrative,
    '',
    '## Rewritten bullets',
    ...result.rewrites.map((rewrite) => `- ${rewrite.after}`),
  ].join('\n')

  return c.text(markdown, 200, {
    'Content-Disposition': `attachment; filename="${result.id}.md"`,
    'Content-Type': 'text/markdown; charset=utf-8',
  })
})

function buildMockResult({
  id,
  fileName,
  resumeText,
  jdText,
  modelUsed = 'mock pipeline',
}: {
  id: string
  fileName: string
  resumeText: string
  jdText: string
  modelUsed?: string
}): AnalysisResult {
  const jdSkills = pickSkills(jdText)
  const resumeSkills = pickSkills(resumeText)
  const matchedSkills = jdSkills.filter((skill) => resumeSkills.includes(skill)).slice(0, 8)
  const missingSkills = jdSkills.filter((skill) => !resumeSkills.includes(skill)).slice(0, 8)
  const fitScore = Math.min(
    96,
    Math.max(38, Math.round((matchedSkills.length / Math.max(jdSkills.length, 1)) * 76 + 18)),
  )

  return {
    id,
    createdAt: new Date().toISOString(),
    fileName,
    jobWords: countWords(jdText),
    tokenEstimate: estimateTokens(resumeText + jdText),
    fitScore,
    matchedSkills: matchedSkills.length ? matchedSkills : ['Communication', 'Project delivery'],
    missingSkills: missingSkills.length ? missingSkills : ['Role-specific metrics', 'Targeted keywords'],
    gapNarrative: `This resume is a ${fitScore}% fit for the pasted role. The strongest alignment is around ${listPhrase(
      matchedSkills,
    )}, while the clearest gaps are ${listPhrase(
      missingSkills,
    )}. Add measurable outcomes, mirror the job description language, and move the most relevant evidence into the top third of the resume.`,
    rewrites: [
      {
        before: 'Worked on projects and helped the team deliver results.',
        after:
          'Delivered cross-functional projects aligned to role priorities, translating ambiguous requirements into measurable outcomes.',
      },
      {
        before: 'Responsible for improving processes and reports.',
        after:
          'Improved reporting workflows by standardizing inputs, surfacing decision-ready metrics, and reducing manual review cycles.',
      },
      {
        before: 'Used different tools to support business needs.',
        after:
          'Applied role-relevant tools and analytical methods to solve business problems and communicate recommendations to stakeholders.',
      },
    ],
    modelUsed,
  }
}

async function runOpenRouterAnalysis({
  apiKey,
  model,
  id,
  fileName,
  resumeText,
  jdText,
  onToken,
}: {
  apiKey: string
  model: string
  id: string
  fileName: string
  resumeText: string
  jdText: string
  onToken: (text: string) => void
}): Promise<AnalysisResult> {
  const response = await fetch(openRouterUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'ResuLens',
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a resume analyst. Return only valid JSON matching the requested schema. Do not use markdown fences.',
        },
        {
          role: 'user',
          content: buildAnalysisPrompt(resumeText, jdText),
        },
      ],
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter returned ${response.status}`)
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let content = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      const data = event
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)

      if (!data || data === '[DONE]') continue

      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>
      }
      const next = parsed.choices?.[0]?.delta?.content
      if (!next) continue

      content += next
      onToken(next)
    }
  }

  const parsed = parseAnalysisJson(content)
  const matchedSkills = cleanStringArray(parsed.matchedSkills)
  const missingSkills = cleanStringArray(parsed.missingSkills)
  const rewrites = Array.isArray(parsed.rewrites)
    ? parsed.rewrites
        .map((rewrite) => ({
          before: String(rewrite?.before ?? '').trim(),
          after: String(rewrite?.after ?? '').trim(),
        }))
        .filter((rewrite) => rewrite.before && rewrite.after)
        .slice(0, 5)
    : []

  return {
    id,
    createdAt: new Date().toISOString(),
    fileName,
    jobWords: countWords(jdText),
    tokenEstimate: estimateTokens(resumeText + jdText),
    fitScore: clampScore(Number(parsed.fitScore)),
    matchedSkills: matchedSkills.length ? matchedSkills : ['Relevant experience'],
    missingSkills: missingSkills.length ? missingSkills : ['More targeted evidence'],
    gapNarrative:
      typeof parsed.gapNarrative === 'string' && parsed.gapNarrative.trim()
        ? parsed.gapNarrative.trim()
        : 'The resume has useful overlap with the role, but it should use more specific evidence and role language.',
    rewrites: rewrites.length
      ? rewrites
      : [
          {
            before: 'Worked on projects and supported team goals.',
            after:
              'Delivered role-aligned projects with measurable outcomes, clear stakeholder communication, and stronger keyword alignment.',
          },
        ],
    modelUsed: model,
  }
}

function buildAnalysisPrompt(resumeText: string, jdText: string) {
  return JSON.stringify({
    task: 'Analyze the resume against the job description.',
    schema: {
      fitScore: 'number from 0 to 100',
      matchedSkills: ['short skill strings found in both texts'],
      missingSkills: ['short skill strings important in the JD but weak or absent in the resume'],
      gapNarrative: 'one concise paragraph with specific recommendations',
      rewrites: [
        {
          before: 'original or representative weak resume bullet',
          after: 'rewritten ATS-friendly bullet aligned to the job description',
        },
      ],
    },
    resumeText: truncateForPrompt(resumeText),
    jobDescription: truncateForPrompt(jdText),
  })
}

function parseAnalysisJson(content: string) {
  const trimmed = content.trim().replace(/^```json\s*|\s*```$/g, '')
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('OpenRouter response did not contain JSON.')
  }
  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as {
    fitScore?: number
    matchedSkills?: unknown
    missingSkills?: unknown
    gapNarrative?: unknown
    rewrites?: Array<{ before?: unknown; after?: unknown }>
  }
}

function rowsFromResult(result: AnalysisResult): SkillRow[] {
  return [
    ...result.matchedSkills.map((skill) => ({
      skill,
      status: 'Matched' as const,
      evidence: 'Detected in both resume and job description text.',
    })),
    ...result.missingSkills.map((skill) => ({
      skill,
      status: 'Missing' as const,
      evidence: 'Important to the role but not clearly represented in the resume.',
    })),
  ]
}

function pickSkills(text: string) {
  const knownSkills = [
    'React',
    'TypeScript',
    'JavaScript',
    'SQL',
    'Python',
    'Cloudflare',
    'AWS',
    'API',
    'Analytics',
    'Leadership',
    'Product',
    'Design',
    'Testing',
    'Automation',
    'Communication',
    'Security',
    'Data',
    'Project delivery',
  ]
  const normalized = text.toLowerCase()
  return knownSkills.filter((skill) => normalized.includes(skill.toLowerCase()))
}

function listPhrase(items: string[]) {
  if (!items.length) return 'general experience and communication'
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function chunkText(text: string) {
  const words = text.split(' ')
  const chunks: string[] = []
  for (let index = 0; index < words.length; index += 5) {
    chunks.push(words.slice(index, index + 5).join(' '))
  }
  return chunks
}

function countWords(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 10)
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 50
  return Math.max(0, Math.min(100, Math.round(value)))
}

function truncateForPrompt(text: string) {
  return text.length > 14000 ? `${text.slice(0, 14000)}\n[truncated]` : text
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default app
