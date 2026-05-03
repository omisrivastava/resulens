import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity,
  Archive,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  Gauge,
  History,
  Loader2,
  LockKeyhole,
  Moon,
  RefreshCw,
  Sparkles,
  Sun,
  Table2,
  Trash2,
  UploadCloud,
  Wand2,
  XCircle,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type SkillRow = {
  skill: string
  status: 'Matched' | 'Missing' | 'Partial'
  evidence: string
}

type Rewrite = {
  before: string
  after: string
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
  rewrites: Rewrite[]
  modelUsed: string
}

type StreamState = {
  id: string
  status: 'idle' | 'extracting' | 'uploading' | 'streaming' | 'complete' | 'error'
  message: string
  result: AnalysisResult | null
  skillRows: SkillRow[]
  liveText: string[]
}

const emptyStream: StreamState = {
  id: '',
  status: 'idle',
  message: '',
  result: null,
  skillRows: [],
  liveText: [],
}

const storageKey = 'resulens-history'
const themeKey = 'resulens-theme'
type Theme = 'light' | 'dark'
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

function App() {
  const [route, setRoute] = useState(() => window.location.pathname)
  const [stream, setStream] = useState<StreamState>(emptyStream)
  const [theme, setTheme] = useState<Theme>(() => loadTheme())

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    localStorage.setItem(themeKey, theme)
  }, [theme])

  const navigate = (path: string) => {
    window.history.pushState({}, '', path)
    setRoute(path)
  }

  const resultMatch = route.match(/^\/result\/([^/]+)$/)

  return (
    <main className="app-shell" data-theme={theme}>
      <Header
        route={route}
        theme={theme}
        onNavigate={navigate}
        onToggleTheme={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
      />
      {route === '/history' ? (
        <HistoryPage onNavigate={navigate} />
      ) : resultMatch ? (
        <ResultPage analysisId={resultMatch[1]} stream={stream} />
      ) : (
        <UploadPage onNavigate={navigate} onStreamChange={setStream} />
      )}
    </main>
  )
}

function Header({
  route,
  theme,
  onNavigate,
  onToggleTheme,
}: {
  route: string
  theme: Theme
  onNavigate: (path: string) => void
  onToggleTheme: () => void
}) {
  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => onNavigate('/')}>
        <span className="brand-mark">
          <Gauge size={20} strokeWidth={2.4} />
        </span>
        <span>
          ResuLens
          <small>AI resume fit analysis</small>
        </span>
      </button>
      <nav aria-label="Primary">
        <button
          className={route === '/' ? 'active' : ''}
          type="button"
          onClick={() => onNavigate('/')}
        >
          <Sparkles size={16} />
          Analyze
        </button>
        <button
          className={route === '/history' ? 'active' : ''}
          type="button"
          onClick={() => onNavigate('/history')}
        >
          <History size={16} />
          History
        </button>
      </nav>
      <button
        className="theme-toggle"
        type="button"
        onClick={onToggleTheme}
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      >
        {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
        <span>{theme === 'light' ? 'Dark' : 'Light'}</span>
      </button>
    </header>
  )
}

function UploadPage({
  onNavigate,
  onStreamChange,
}: {
  onNavigate: (path: string) => void
  onStreamChange: (state: StreamState | ((state: StreamState) => StreamState)) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [jdText, setJdText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const wordCount = useMemo(() => countWords(jdText), [jdText])
  const tokenEstimate = useMemo(() => estimateTokens(jdText), [jdText])
  const ready = Boolean(file && jdText.trim())

  const selectFile = (nextFile?: File) => {
    if (!nextFile) return
    if (nextFile.type !== 'application/pdf') {
      setError('Please choose a PDF resume.')
      return
    }
    setError('')
    setFile(nextFile)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !jdText.trim()) {
      setError('Add a resume PDF and a job description before starting.')
      return
    }

    const id = crypto.randomUUID()
    onNavigate(`/result/${id}`)
    onStreamChange({
      ...emptyStream,
      id,
      status: 'extracting',
      message: 'Extracting resume text in the browser...',
    })

    try {
      const resumeText = await extractPdfText(file)

      onStreamChange((state) => ({
        ...state,
        status: 'uploading',
        message: 'Creating an archive upload slot...',
      }))

      await fetch(apiUrl('/api/upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          fileName: file.name,
          contentType: file.type,
          resumeText,
          jdText,
        }),
      })

      onStreamChange((state) => ({
        ...state,
        status: 'streaming',
        message: 'Streaming analysis...',
      }))

      await streamAnalysis({
        id,
        fileName: file.name,
        resumeText,
        jdText,
        onEvent: (eventName, data) => {
          onStreamChange((state) => reduceStreamEvent(state, eventName, data))
        },
      })
    } catch (caught) {
      onStreamChange((state) => ({
        ...state,
        status: 'error',
        message: caught instanceof Error ? caught.message : 'Analysis failed.',
      }))
    }
  }

  return (
    <section className="workspace">
      <form className="upload-panel" onSubmit={submit}>
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Resume match lab</p>
            <h1>Score a resume against a job description.</h1>
          </div>
          <StatusBadge ready={ready} />
        </div>

        <button
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            selectFile(event.dataTransfer.files[0])
          }}
        >
          <span className="drop-icon">
            {file ? <CheckCircle2 size={26} /> : <UploadCloud size={28} />}
          </span>
          <span>{file ? file.name : 'Drop resume PDF or choose file'}</span>
          <small>
            {file ? `${formatBytes(file.size)} selected` : 'Text is extracted locally before analysis'}
          </small>
        </button>
        <input
          ref={inputRef}
          hidden
          type="file"
          accept="application/pdf"
          onChange={(event) => selectFile(event.target.files?.[0])}
        />

        <label className="jd-box">
          <span>
            <ClipboardList size={17} />
            Job description
          </span>
          <textarea
            value={jdText}
            onChange={(event) => setJdText(event.target.value)}
            placeholder="Paste the role description, responsibilities, and required skills..."
          />
        </label>

        <div className="metrics-row" aria-live="polite">
          <Metric icon={<FileText size={18} />} label="Words" value={wordCount.toLocaleString()} />
          <Metric icon={<BarChart3 size={18} />} label="Est. tokens" value={tokenEstimate.toLocaleString()} />
          <Metric icon={<LockKeyhole size={18} />} label="Privacy" value="Local PDF parse" />
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        <button className="primary-action" type="submit">
          Start analysis
          <ArrowRight size={18} />
        </button>
      </form>

      <aside className="pipeline-panel" aria-label="Pipeline">
        <div className="pipeline-card-head">
          <p className="eyebrow">Cloudflare pipeline</p>
          <strong>Live analysis path</strong>
        </div>
        {[
          { label: 'PDF parse', icon: FileText },
          { label: 'R2 archive slot', icon: Archive },
          { label: 'Fit score', icon: Gauge },
          { label: 'Gap analysis', icon: Table2 },
          { label: 'Bullet rewrite', icon: Wand2 },
        ].map((step, index) => {
          const Icon = step.icon
          return (
            <div className="pipeline-step" key={step.label}>
              <span>
                <Icon size={17} />
              </span>
              <p>{step.label}</p>
              <small>{index + 1}</small>
            </div>
          )
        })}
        <div className="side-note">
          <Activity size={18} />
          SSE keeps the result page updating while the model writes.
        </div>
      </aside>
    </section>
  )
}

function StatusBadge({ ready }: { ready: boolean }) {
  return (
    <div className={`status-badge ${ready ? 'ready' : ''}`}>
      {ready ? <CheckCircle2 size={17} /> : <Loader2 size={17} />}
      {ready ? 'Ready' : 'Waiting'}
    </div>
  )
}

function ResultPage({
  analysisId,
  stream,
}: {
  analysisId: string
  stream: StreamState
}) {
  const saved = loadHistory().find((item) => item.id === analysisId)
  const result = stream.id === analysisId ? stream.result : saved
  const skillRows = stream.id === analysisId ? stream.skillRows : rowsFromResult(saved)
  const liveText = stream.id === analysisId ? stream.liveText : []
  const isActive = stream.id === analysisId && ['extracting', 'uploading', 'streaming'].includes(stream.status)
  const matchedCount = skillRows.filter((row) => row.status === 'Matched').length
  const missingCount = skillRows.filter((row) => row.status === 'Missing').length

  if (!result && !isActive) {
    return (
      <section className="empty-state">
        <XCircle size={36} />
        <h1>Analysis not found</h1>
        <p>Run a new analysis or open one from history.</p>
      </section>
    )
  }

  return (
    <section className="result-layout">
      <div className="score-panel">
        <ScoreRing score={result?.fitScore ?? 0} busy={isActive} />
        <div className="score-copy">
          <p className="eyebrow">{isActive ? stream.message : 'Completed analysis'}</p>
          <h1>{result?.fileName ?? 'Resume analysis in progress'}</h1>
          <p className="muted">
            {result
              ? `${result.modelUsed} - ${result.tokenEstimate.toLocaleString()} estimated tokens`
              : 'The Worker is sending each stage as soon as it is ready.'}
          </p>
        </div>
        <div className="result-stats">
          <Metric icon={<CheckCircle2 size={18} />} label="Matched" value={matchedCount.toString()} />
          <Metric icon={<XCircle size={18} />} label="Gaps" value={missingCount.toString()} />
        </div>
      </div>

      <div className="result-grid">
        <section className="result-section skill-section">
          <SectionTitle icon={<Table2 size={19} />} title="Skill gaps" />
          <div className="skill-table">
            {skillRows.length ? (
              skillRows.map((row) => (
                <div className="skill-row" key={`${row.skill}-${row.status}`}>
                  <strong>{row.skill}</strong>
                  <span className={`pill ${row.status.toLowerCase()}`}>{row.status}</span>
                  <p>{row.evidence}</p>
                </div>
              ))
            ) : (
              <LoadingLine text="Waiting for structured skills..." />
            )}
          </div>
        </section>

        <section className="result-section">
          <SectionTitle icon={<Activity size={19} />} title="Gap narrative" />
          <p className="narrative">
            {result?.gapNarrative ?? (liveText.join(' ') || 'The first model tokens will appear here.')}
          </p>
        </section>

        <section className="result-section rewrite-section">
          <SectionTitle icon={<Wand2 size={19} />} title="Rewritten bullets" />
          <div className="rewrite-list">
            {(result?.rewrites ?? []).map((rewrite) => (
              <article className="rewrite-card" key={rewrite.after}>
                <p className="before">{rewrite.before}</p>
                <ChevronRight size={18} aria-hidden="true" />
                <p className="after">{rewrite.after}</p>
              </article>
            ))}
            {!result?.rewrites.length ? <LoadingLine text="Waiting for rewritten bullets..." /> : null}
          </div>
        </section>
      </div>
    </section>
  )
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="section-title">
      <span>{icon}</span>
      <h2>{title}</h2>
    </div>
  )
}

function LoadingLine({ text }: { text: string }) {
  return (
    <p className="loading-line">
      <Loader2 size={16} />
      {text}
    </p>
  )
}

function HistoryPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [items, setItems] = useState<AnalysisResult[]>(() => loadHistory())

  useEffect(() => {
    fetch(apiUrl('/api/history'))
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { analyses?: AnalysisResult[] } | null) => {
        if (data?.analyses?.length) setItems(data.analyses)
      })
      .catch(() => undefined)
  }, [])

  const deleteItem = (id: string, fileName: string) => {
    const confirmed = window.confirm(`Delete "${fileName}" from history?`)
    if (!confirmed) return

    const next = items.filter((item) => item.id !== id)
    setItems(next)
    saveHistoryList(next)
    fetch(apiUrl(`/api/result/${id}`), { method: 'DELETE' }).catch(() => undefined)
  }

  const clearAll = () => {
    const confirmed = window.confirm('Delete all saved analyses from history?')
    if (!confirmed) return

    setItems([])
    saveHistoryList([])
    fetch(apiUrl('/api/history'), { method: 'DELETE' }).catch(() => undefined)
  }

  return (
    <section className="history-page">
      <div className="history-heading">
        <div>
          <p className="eyebrow">Past analyses</p>
          <h1>History</h1>
        </div>
        <div className="history-heading-actions">
          <span>{items.length} saved</span>
          {items.length ? (
            <button className="danger-action" type="button" onClick={clearAll}>
              <Trash2 size={16} />
              Clear all
            </button>
          ) : null}
        </div>
      </div>
      <div className="history-list">
        {items.length ? (
          items.map((item) => (
            <article className="history-item" key={item.id}>
              <ScoreMini score={item.fitScore} />
              <div>
                <strong>{item.fileName}</strong>
                <p>
                  {new Date(item.createdAt).toLocaleString()} - {item.fitScore}% fit
                </p>
              </div>
              <div className="history-actions">
                <button type="button" onClick={() => onNavigate(`/result/${item.id}`)}>
                  <RefreshCw size={16} />
                  Open
                </button>
                <a href={apiUrl(`/api/export/${item.id}`)} target="_blank">
                  <Download size={16} />
                  Export
                </a>
                <button
                  className="danger-action"
                  type="button"
                  onClick={() => deleteItem(item.id, item.fileName)}
                >
                  <Trash2 size={16} />
                  Delete
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-state compact">
            <History size={34} />
            <p className="muted">No analyses yet.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <div className="metric">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  )
}

function ScoreMini({ score }: { score: number }) {
  return (
    <div className="score-mini" aria-label={`Fit score ${score}`}>
      {score}
    </div>
  )
}

function ScoreRing({ score, busy }: { score: number; busy: boolean }) {
  return (
    <div
      className={`score-ring ${busy ? 'busy' : ''}`}
      style={{ '--score': `${Math.max(score, 2) * 3.6}deg` } as React.CSSProperties}
      aria-label={`Fit score ${score}`}
    >
      <span>{busy ? <Loader2 size={38} /> : score}</span>
      <small>fit score</small>
    </div>
  )
}

async function extractPdfText(file: File) {
  const data = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, index) => {
      const page = await pdf.getPage(index + 1)
      const content = await page.getTextContent()
      return content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    }),
  )
  return pages.join('\n\n').trim()
}

async function streamAnalysis({
  id,
  fileName,
  resumeText,
  jdText,
  onEvent,
}: {
  id: string
  fileName: string
  resumeText: string
  jdText: string
  onEvent: (eventName: string, data: unknown) => void
}) {
  const response = await fetch(apiUrl('/api/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, fileName, resumeText, jdText }),
  })

  if (!response.ok || !response.body) {
    throw new Error('The analysis stream could not be started.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const raw of events) {
      const parsed = parseSse(raw)
      if (parsed) onEvent(parsed.event, parsed.data)
    }
  }
}

function parseSse(raw: string) {
  const event = raw.match(/^event: (.+)$/m)?.[1] ?? 'message'
  const dataLine = raw.match(/^data: (.+)$/m)?.[1]
  if (!dataLine) return null
  return { event, data: JSON.parse(dataLine) }
}

function reduceStreamEvent(state: StreamState, eventName: string, data: unknown): StreamState {
  if (eventName === 'skills') {
    return { ...state, skillRows: data as SkillRow[], message: 'Scoring matched and missing skills...' }
  }
  if (eventName === 'token') {
    return { ...state, liveText: [...state.liveText, String((data as { text: string }).text)] }
  }
  if (eventName === 'complete') {
    const result = data as AnalysisResult
    saveHistory(result)
    return {
      ...state,
      status: 'complete',
      message: 'Analysis complete',
      result,
      skillRows: rowsFromResult(result),
    }
  }
  return state
}

function rowsFromResult(result?: AnalysisResult | null): SkillRow[] {
  if (!result) return []
  return [
    ...result.matchedSkills.map((skill) => ({
      skill,
      status: 'Matched' as const,
      evidence: 'Found in the resume text and aligned with the role.',
    })),
    ...result.missingSkills.map((skill) => ({
      skill,
      status: 'Missing' as const,
      evidence: 'Important in the job description but not clearly present in the resume.',
    })),
  ]
}

function countWords(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`
}

function loadHistory(): AnalysisResult[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as AnalysisResult[]
  } catch {
    return []
  }
}

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(themeKey)
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function saveHistory(result: AnalysisResult) {
  const next = [result, ...loadHistory().filter((item) => item.id !== result.id)].slice(0, 20)
  saveHistoryList(next)
}

function saveHistoryList(items: AnalysisResult[]) {
  localStorage.setItem(storageKey, JSON.stringify(items))
}

export default App
