import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Puck, Render, type Data } from '@puckeditor/core';
import { createClient } from '@eclosion-tech/grove/client';
import { EditingSession } from '@eclosion-tech/grove/editing';
import type { Document, Json, SchemaRecord, Scope, DeliveredDocument } from '@eclosion-tech/grove';
import { config, readContent, SiteMode, ArticleBody, GroveFields } from './blocks.js';
import { readPage, validateLayout, type Blocks } from './manifest.js';
import '@puckeditor/core/no-external.css';
import './style.css';

const query = new URLSearchParams(location.search);
const id = query.get('id') ?? 'home';
const mode = query.get('mode') ?? 'live';
type Session = { scope: Scope; csrf: string };

function App() {
  const [content, setContent] = useState<DeliveredDocument | null>(null);
  const [editing, setEditing] = useState<{ document: Document; registry: SchemaRecord; session: Session } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    async function load() {
      try {
        if (mode === 'edit') {
          const response = await fetch('/auth/session');
          if (!response.ok) throw new Error('Sign in to Grove before editing this page.');
          const session = await response.json() as Session;
          const client = createClient({ baseUrl: location.origin, scope: session.scope, headers: () => ({ 'X-Grove-CSRF': session.csrf }) });
          const [document, registry] = await Promise.all([client.getDocument(id), client.getSchema()]);
          if (!registry || document.type !== 'page') throw new Error('This document is not a composable page.');
          readPage(document.draft); setEditing({ document, registry, session });
        } else {
          if (!['live', 'preview'].includes(mode)) throw new Error('Unknown page mode.');
          const content = await readContent(id, mode === 'preview' ? 'preview' : 'live');
          if (content.type === 'page') readPage(content.data);
          else if (content.type !== 'article') throw new Error('No site template is registered for this collection.');
          setContent(content);
        }
      } catch (error) { setError(error instanceof Error ? error.message : 'Could not open this page.'); }
    }
    void load();
  }, []);
  if (error) return <div className="site-message"><h1>This page isn’t ready to open.</h1><p>{error}</p><a href="/">Back to Grove ↗</a></div>;
  if (editing) return <PageEditor {...editing}/>;
  if (!content) return <div className="site-message">Opening Fieldnotes…</div>;
  return <SiteMode.Provider value={mode === 'preview' ? 'preview' : 'live'}>{mode === 'preview' && <div className="preview-banner"><strong>Draft preview</strong><span>Only signed-in editors can see this version.</span><a href="/">Back to Grove</a></div>}{content.type === 'page' ? <Render config={config} data={readPage(content.data)}/> : <div className="fieldnotes-page"><nav className="site-nav"><a className="site-wordmark" href="/example-site/">fieldnotes®</a><a href="/">Grove ↗</a></nav><ArticleBody content={content.data}/></div>}</SiteMode.Provider>;
}

function PageEditor({ document, registry, session: auth }: { document: Document; registry: SchemaRecord; session: Session }) {
  const client = useMemo(() => createClient({ baseUrl: location.origin, scope: auth.scope, headers: () => ({ 'X-Grove-CSRF': auth.csrf }) }), [auth]);
  const [session] = useState(() => new EditingSession(client, document, registry));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    session.start();
    const leave = (event: BeforeUnloadEvent) => { if (session.unsettled) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => { session.stop(); window.removeEventListener('beforeunload', leave); };
  }, [session]);
  const data = useMemo(() => readPage(document.draft), [document.id]);
  function change(data: Data<Blocks>) {
    try {
      const clean = JSON.parse(JSON.stringify(data)) as Json;
      validateLayout(clean); session.setInvalid('layout', false); session.setField('layout', clean); setError('');
    } catch (error) { session.setInvalid('layout', true); setError(error instanceof Error ? error.message : 'Invalid page'); }
  }
  async function publish(data: Data<Blocks>) {
    change(data);
    const saved = await session.action('publish');
    if (saved) setNotice('Published. Your page is live.');
  }
  return <GroveFields.Provider value={{ client, registry }}><SiteMode.Provider value="preview"><div className="page-edit-toolbar"><a href="/" onClick={e => { e.preventDefault(); void session.flush().then(saved => { if (saved) location.assign('/'); }); }}>← Grove content</a><span>{String(state.data.title)} <small>· Page editor</small></span><a href={`/example-site/?id=${encodeURIComponent(id)}&mode=preview`} target="_blank" rel="noreferrer" onClick={e => { if (session.unsettled) { e.preventDefault(); void session.flush().then(saved => { if (saved) setNotice('Draft saved. Open preview again to view it.'); }); } }}>Preview saved draft ↗</a></div>
    {(state.error || error || notice) && <div role={state.error || error ? 'alert' : 'status'} className={`page-notice ${state.error || error ? 'failure' : ''}`}>{state.error || error || notice}{state.status === 'conflict' && <><span>Your local composition is preserved. Export it before reloading the latest version.</span><button onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' }));
      const a = window.document.createElement('a'); a.href = url; a.download = `${id}-draft.json`; a.click(); URL.revokeObjectURL(url);
    }}>Export my draft</button><button onClick={() => { if (window.confirm('Load the latest saved page? Export your unsaved changes first if you want to keep them.')) location.reload(); }}>Load latest page</button></>}</div>}
    <div className={state.busy || state.status === 'conflict' ? 'puck-locked' : ''}>
      <Puck config={config} data={data} iframe={{ enabled: true }} headerTitle="Fieldnotes" headerPath={`/${id}`} onChange={change} onPublish={publish}
        fieldTransforms={{ richtext: ({ value }) => value }}
        overrides={{ headerActions: ({ children }) => <><span className="puck-save-state">{state.invalid.length ? 'Invalid composition' : state.status === 'saving' ? 'Saving…' : state.status === 'saved' ? 'All changes saved' : state.status === 'conflict' ? 'Save conflict' : 'Unsaved changes'}</span><button disabled={state.busy || state.status === 'conflict' || !!state.invalid.length} onClick={() => void session.flush()}>Save draft</button><div className={state.busy || state.status === 'conflict' || state.invalid.length ? 'publish-disabled' : ''}>{children}</div></> }}
      />
    </div>
  </SiteMode.Provider></GroveFields.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
