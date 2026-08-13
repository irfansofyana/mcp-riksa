import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

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
