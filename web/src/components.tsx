import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { buildTraceRows, normalizeMcpContent, traceWindowMs } from './model.js';
import type { EventRecord } from './types.js';

export function Button({ variant = 'default', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }) {
  return <button className={`button ${variant} ${className}`} {...props} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} />; }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} />; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} />; }

export function Section({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`section ${className}`}><header className="section-header"><h2>{title}</h2>{action}</header>{children}</section>;
}

export function Status({ value }: { value: string }) {
  const tone = ['passed', 'pass', 'authorized', 'connected', 'complete'].includes(value.toLowerCase()) ? 'pass' : ['failed', 'fail', 'denied', 'error'].includes(value.toLowerCase()) ? 'fail' : 'neutral';
  return <span className={`status ${tone}`}>{value}</span>;
}

export function JsonView({ value, label = 'Sanitized JSON', defaultOpen = true }: { value: unknown; label?: string; defaultOpen?: boolean }) {
  return <details className="json-view" open={defaultOpen || undefined}><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p>; }

export function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
  return <div role="status" className={`notice ${error ? 'error' : ''}`}>{children}</div>;
}

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, '');
  const language = className?.replace(/^language-/, '') ?? 'text';
  return <div className="markdown-code"><header><span>{language}</span><button onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}>{copied ? 'Copied' : 'Copy'}</button></header><pre><code className={className}>{text}</code></pre></div>;
}

export function MarkdownContent({ children, className = '' }: { children: string; className?: string }) {
  return <div className={`markdown-body ${className}`}><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    components={{
      a: ({ href, children: content }) => {
        const safe = safeHref(href);
        return safe ? <a href={safe} target="_blank" rel="noreferrer">{content}</a> : <span>{content}</span>;
      },
      img: ({ alt }) => <span className="markdown-image-omitted">[remote image omitted{alt ? `: ${alt}` : ''}]</span>,
      pre: ({ children: content }) => <>{content}</>,
      code: ({ className: codeClass, children: content }) => {
        const text = String(content);
        return text.includes('\n') || codeClass ? <CodeBlock className={codeClass}>{content}</CodeBlock> : <code className={codeClass}>{content}</code>;
      },
    }}
  >{children}</ReactMarkdown></div>;
}

export function RichToolResult({ value }: { value: unknown }) {
  const blocks = normalizeMcpContent(value);
  return <div className="rich-tool-result">{blocks.map((block, index) => {
    if (block.type === 'text') return <MarkdownContent key={index}>{block.text}</MarkdownContent>;
    if (block.type === 'image') return <figure key={index} className="content-image"><img src={`data:${block.mimeType};base64,${block.data}`} alt="MCP tool result" /><figcaption>{block.mimeType} · inline MCP content</figcaption></figure>;
    if (block.type === 'resource_link') {
      const href = safeHref(block.uri);
      return <div key={index} className="resource-card"><span>Resource</span><b>{block.name ?? block.uri}</b>{block.description ? <p>{block.description}</p> : null}{href ? <a href={href} target="_blank" rel="noreferrer">Open resource ↗</a> : <code>{block.uri}</code>}</div>;
    }
    if (block.type === 'resource') return <div key={index} className="resource-card"><span>Embedded resource</span><b>{block.uri ?? 'Inline content'}</b>{block.text ? <MarkdownContent>{block.text}</MarkdownContent> : <JsonView value={block} defaultOpen={false} />}</div>;
    if (block.type === 'structured') return <JsonView key={index} value={block.value} label="Structured content" defaultOpen={false} />;
    return <JsonView key={index} value={block.value} label={`Unsupported ${block.originalType} content`} defaultOpen={false} />;
  })}</div>;
}

export function TraceTimeline({ events, durationMs = 0 }: { events: EventRecord[]; durationMs?: number }) {
  const rows = buildTraceRows(events, durationMs);
  const windowMs = traceWindowMs(events, durationMs);
  const totalTokens = events.reduce((sum, entry) => {
    const data = entry.data as { usage?: { total?: number } } | undefined;
    return sum + (data?.usage?.total ?? 0);
  }, 0);
  return <div className="trace-observability">
    <header className="trace-summary"><div><span className="eyebrow">Trace overview</span><b>{rows.length} spans</b></div><div><span>{windowMs} ms wall time</span><span>{durationMs} ms active</span><span>{totalTokens} tokens</span></div></header>
    <div className="trace-ruler"><span>0 ms</span><i /><span>{windowMs} ms</span></div>
    <div className="trace-spans">{rows.length === 0 ? <Empty>No persisted spans yet.</Empty> : rows.map((row) => <details key={row.id} className={`trace-span ${row.kind}`}>
      <summary><span className="trace-span-name"><i />{row.name}</span><span className="trace-waterfall"><i style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%` }} /></span><time>{row.durationMs} ms</time></summary>
      <div className="trace-span-detail"><div><span>Kind</span><b>{row.kind}</b></div><div><span>Timestamp</span><b>{row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : 'n/a'}</b></div><JsonView value={row.data} label="Sanitized input / output" defaultOpen={false} /></div>
    </details>)}</div>
  </div>;
}
