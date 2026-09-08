import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, Download, History, Leaf, RotateCcw, X } from 'lucide-react';
import { EditingSession, sameContent } from '@eclosion-tech/grove/editing';
import type { createClient } from '@eclosion-tech/grove/client';
import type { Content, Document, Field, HistoryEntry, Json, SchemaRecord } from '@eclosion-tech/grove';

import { ReferenceInput, Usages } from '../../shared/References.js';

type Props = { doc: Document; registry: SchemaRecord; client: ReturnType<typeof createClient>; onChange: (doc: Document) => void; onBack: () => void; onOpen: (id: string) => void; registerGuard: (guard: () => Promise<boolean>) => () => void };
export const documentTitle = (doc: Document, locale = 'en') => {
  const title = doc.draft.title;
  return typeof title === 'string' ? title : title && typeof title === 'object' && !Array.isArray(title) ? String(title[locale] ?? Object.values(title)[0] ?? doc.id) : doc.id;
};
export const documentStatus = (doc: Document) => !doc.published ? 'Draft' : sameContent(doc.draft, doc.published) ? 'Published' : 'Changes';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} aria-label={title} className="modal" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) { const bounds = e.currentTarget.getBoundingClientRect(); if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onClose(); } }}><button className="modal-close icon-button" aria-label="Close dialog" onClick={onClose}><X size={19}/></button><h2>{title}</h2>{children}</dialog>;
}

export function Editor({ doc, registry, client, onChange, onBack, onOpen, registerGuard }: Props) {
  const [session] = useState(() => new EditingSession(client, doc, registry));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [locale, setLocale] = useState(registry.definition.defaultLocale);
  const [usage, setUsage] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [inspect, setInspect] = useState<HistoryEntry | null>(null);
  const [latest, setLatest] = useState<Awaited<ReturnType<EditingSession['latest']>> | null>(null);
  const [notice, setNotice] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState(0);
  const type = state.registry.definition.types.find(t => t.name === state.document.type);
  const changeRef = useRef(onChange); changeRef.current = onChange;
  useEffect(() => { changeRef.current(state.document); }, [state.document]);
  useEffect(() => {
    session.start();
    const unregister = registerGuard(async () => {
      const saved = await session.flush();
      if (!saved) setNotice('Your changes are still here. Resolve the save issue before leaving, or export a copy.');
      return !!saved;
    });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (session.unsettled) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { unregister(); session.stop(); window.removeEventListener('beforeunload', beforeUnload); };
  }, [session]);
  const isPage = doc.type === 'page';
  const canPreview = isPage || doc.type === 'article';
  const pageUrl = `/example-site/?id=${encodeURIComponent(doc.id)}`;
  async function openPreview(mode: 'preview' | 'live') {
    if (!await session.flush()) return;
    window.open(`${pageUrl}&mode=${mode}`, '_blank', 'noopener,noreferrer');
  }
  async function readHistory(more = false) {
    setHistoryError('');
    try { const entries = await client.history(doc.id, { before: more ? history?.at(-1)?.revision : undefined, limit: 20 }); setHistory(rows => more ? [...rows ?? [], ...entries] : entries); setHasMoreHistory(entries.length === 20); }
    catch (error) { setHistoryError(errorMessage(error)); }
  }
  async function run(action: 'publish' | 'unpublish' | 'restore', revision?: number) {
    setNotice('');
    const result = await session.action(action, revision);
    if (result) {
      setNotice(action === 'publish' ? 'Published. Your live content is up to date.' : action === 'restore' ? 'Restored as a new draft. The published version is unchanged.' : 'Unpublished. Your draft is still here.');
      setInspect(null); setWithdrawing(false); setRecoveryKey(k => k + 1);
      if (history) await readHistory();
    }
  }
  async function duplicate() {
    const saved = await session.flush(); if (!saved || !type) return;
    try {
      const data: Content = Object.fromEntries(type.fields.filter(f => saved.draft[f.name] !== undefined).map(f => [f.name, saved.draft[f.name]!]));
      if (typeof data.title === 'string') data.title += ' (copy)';
      else if (data.title && typeof data.title === 'object' && !Array.isArray(data.title)) data.title = Object.fromEntries(Object.entries(data.title).map(([key, value]) => [key, `${value ?? ''} (copy)`]));
      const copy = await client.saveDocument(crypto.randomUUID(), { type: saved.type, expectedRevision: 0, expectedSchemaVersion: state.registry.version, data });
      onChange(copy);
    } catch (error) { setNotice(errorMessage(error)); }
  }
  const locked = state.busy || state.status === 'conflict';
  return <section className="editor-view">
    <div className="editor-heading"><button className="text-button" onClick={onBack}>← {type?.label ?? doc.type}</button><div className="editor-actions"><span className="save-state" role="status">{state.invalid.length ? 'Invalid field' : ({ saved: 'All changes saved', unsaved: 'Unsaved changes', saving: 'Saving…', conflict: 'Save conflict', error: 'Not saved' })[state.status]}</span><button disabled={locked || !!state.invalid.length} onClick={() => void session.flush()}>Save draft</button><button disabled={locked || !!state.invalid.length} className="primary" onClick={() => void run('publish')}>Publish<ArrowUpRight size={16}/></button></div></div>
    <div className="editor-title"><span className={`badge ${documentStatus(state.document).toLowerCase()}`}><i/>{documentStatus(state.document)}</span><h1>{documentTitle({ ...state.document, draft: state.data }, state.registry.definition.defaultLocale)}</h1></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    {(state.error || state.invalid.length > 0) && <div className="error" role="alert">{state.error || 'Fix the highlighted fields before saving or publishing.'}{state.status === 'conflict' && <div className="button-row"><button onClick={() => { void session.latest().then(setLatest).catch(e => setNotice(errorMessage(e))); }}>Compare with latest</button><button onClick={() => download(`${doc.id}-unsaved.json`, state.data)}><Download size={15}/>Export my draft</button></div>}{state.status === 'error' && <button onClick={() => void session.flush()}>Retry save</button>}</div>}
    <div className="editor-grid"><div className="form-panel"><div className="panel-heading"><h2>Content</h2>{type?.fields.some(f => f.localized) && <label className="locale-label">Language<select value={locale} onChange={e => { if (state.invalid.length) setNotice('Fix the invalid field before switching languages.'); else setLocale(e.target.value); }}>{state.registry.definition.locales.map(l => <option key={l}>{l}</option>)}</select></label>}</div>
      <fieldset disabled={locked}>{type ? type.fields.map(field => isPage && field.name === 'layout' ? <div className="page-composition" key={field.name}><span className="eyebrow">YOUR SITE, YOUR COMPONENTS</span><h2>Shape this page on your site.</h2><p>Arrange sections and edit rich text with the same components your visitors see.</p><a className="button primary" href={`${pageUrl}&mode=edit`} onClick={e => { e.preventDefault(); void session.flush().then(saved => { if (saved) location.assign(`${pageUrl}&mode=edit`); }); }}>Open page editor<ArrowUpRight size={17}/></a></div> : <FieldInput client={client} registry={state.registry} key={`${field.name}-${locale}-${recoveryKey}`} field={field} locale={locale} value={state.data[field.name]} onChange={value => session.setField(field.name, value)} onInvalid={invalid => session.setInvalid(field.name, invalid)}/>) : <p>This collection was removed. Export your draft before leaving.</p>}</fieldset>
    </div><aside className="details-panel"><h2>Document details</h2><dl><dt>Collection</dt><dd>{type?.label ?? doc.type}</dd><dt>Last saved</dt><dd>{new Date(state.document.updatedAt).toLocaleString()}</dd><dt>Published</dt><dd>{state.document.publishedAt ? new Date(state.document.publishedAt).toLocaleString() : 'Not yet'}</dd></dl>
      <div className="detail-actions"><button type="button" onClick={() => setUsage(true)}>Where it’s used</button><button disabled={state.busy} onClick={() => void readHistory()}><History size={16}/>Version history</button><button disabled={locked || !!state.invalid.length} onClick={() => void duplicate()}><Copy size={16}/>Duplicate as draft</button>{canPreview && <><button disabled={locked || !!state.invalid.length} onClick={() => void openPreview('preview')}><ArrowUpRight size={16}/>Preview saved draft</button>{state.document.published && <a className="button" href={`${pageUrl}&mode=live`} target="_blank" rel="noreferrer"><ArrowUpRight size={16}/>View live content</a>}</>}{state.document.published && <button disabled={locked} onClick={() => setWithdrawing(true)}>Unpublish</button>}</div>
      {historyError && <p className="error" role="alert">{historyError}</p>}<div className="quiet-note"><Leaf size={18}/><p>Changes save automatically. Publishing is always your choice.</p><small>Saved revision {state.document.revision}{state.document.publishedRevision ? ` · Live revision ${state.document.publishedRevision}` : ''}</small></div>
    </aside></div>
    {usage && <Modal title="Where it’s used" onClose={() => setUsage(false)}><Usages client={client} id={doc.id} onOpen={onOpen}/></Modal>}
    {history && <Modal title="Version history" onClose={() => { setHistory(null); setInspect(null); }}><p className="muted">Every saved revision, with a way back.</p><div className="history-list">{history.map(entry => <button key={entry.revision} className={inspect?.revision === entry.revision ? 'history-item chosen' : 'history-item'} onClick={() => setInspect(entry)}><span><strong>{entry.action[0]!.toUpperCase() + entry.action.slice(1)} · revision {entry.revision}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {entry.actorId}</small></span><span>{entry.revision === state.document.revision ? 'Current' : 'Inspect'}</span></button>)}</div>{hasMoreHistory && <button onClick={() => void readHistory(true)}>Load earlier versions</button>}{inspect && <div className="history-inspect"><pre>{JSON.stringify(inspect.data, null, 2)}</pre><button className="primary" disabled={state.busy || state.status === 'conflict' || inspect.revision === state.document.revision || !!state.invalid.length} onClick={() => void run('restore', inspect.revision)}><RotateCcw size={16}/>Restore as draft</button><small>Your current changes are saved first. Live content stays unchanged.</small></div>}{(state.error || historyError) && <p className="error">{state.error || historyError}</p>}</Modal>}
    {latest && <Modal title="Another version was saved" onClose={() => setLatest(null)}><p className="muted">Review both drafts. Keeping your edits replaces only the fields you changed.</p><div className="conflict-columns"><div><h3>Your draft</h3><pre>{JSON.stringify(state.data, null, 2)}</pre></div><div><h3>Latest saved draft</h3><pre>{JSON.stringify(latest.document.draft, null, 2)}</pre></div></div><div className="button-row"><button onClick={() => { session.recover(latest, false); setLatest(null); setRecoveryKey(k => k + 1); }}>Use latest draft</button><button className="primary" disabled={latest.registry.version !== state.registry.version} onClick={() => { session.recover(latest, true); setLatest(null); setNotice('Your edits are applied locally. Review them, then save the draft.'); setRecoveryKey(k => k + 1); }}>Keep my changed fields</button></div>{latest.registry.version !== state.registry.version && <p className="muted">The schema also changed. Export your draft, then load the latest version before editing again.</p>}</Modal>}
    {withdrawing && <Modal title="Unpublish this document?" onClose={() => setWithdrawing(false)}><p>This removes the live version from content delivery. Your draft and history stay available.</p><button className="primary" disabled={state.busy} onClick={() => void run('unpublish')}>Unpublish</button></Modal>}
  </section>;
}

function FieldInput({ client, registry, field, value, locale, onChange, onInvalid }: { client: ReturnType<typeof createClient>; registry: SchemaRecord; field: Field; value: Json | undefined; locale: string; onChange: (value: Json) => void; onInvalid: (invalid: boolean) => void }) {
  const localized = field.localized && value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const actual = field.localized ? localized[locale] : value;
  const change = (v: Json) => onChange(field.localized ? { ...localized, [locale]: v } : v);
  if (field.type === 'reference' || field.type === 'image') return <div className="field"><span>{field.label ?? field.name}<span className="field-note">{field.required ? 'Required' : 'Optional'}</span></span><ReferenceInput client={client} registry={registry} value={actual} onChange={change} to={field.to} multiple={field.multiple} image={field.type === 'image'}/></div>;
  return <label className="field"><span>{field.label ?? field.name}<span className="field-note">{field.required ? 'Required' : 'Optional'}{field.localized ? ` · ${locale}` : ''}</span></span>{field.type === 'boolean' ? <span className="boolean-field"><input type="checkbox" checked={actual === true} onChange={e => change(e.target.checked)}/>{actual === true ? 'Enabled' : 'Disabled'}</span> : field.type === 'text' ? <textarea rows={7} value={String(actual ?? '')} onChange={e => change(e.target.value)}/> : field.type === 'json' ? <JsonInput value={actual} onChange={change} onInvalid={onInvalid}/> : <input type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 'any' : undefined} value={String(actual ?? '')} onChange={e => {
    if (field.type === 'number') { const invalid = e.target.validity.badInput || (e.target.value !== '' && !Number.isFinite(Number(e.target.value))); onInvalid(invalid); if (!invalid) change(e.target.value === '' ? null : Number(e.target.value)); }
    else change(e.target.value);
  }}/>}</label>;
}
function JsonInput({ value, onChange, onInvalid }: { value: Json | undefined; onChange: (value: Json) => void; onInvalid: (invalid: boolean) => void }) {
  const [raw, setRaw] = useState(JSON.stringify(value ?? null, null, 2)); const [invalid, setInvalid] = useState(false);
  return <><textarea rows={8} className="code-input" value={raw} aria-invalid={invalid} onChange={e => { setRaw(e.target.value); try { const value = JSON.parse(e.target.value); setInvalid(false); onInvalid(false); onChange(value); } catch { setInvalid(true); onInvalid(true); } }}/>{invalid && <small className="error">Enter valid JSON before saving.</small>}</>;
}
