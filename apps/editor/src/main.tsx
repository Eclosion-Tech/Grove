import { EmailWorkspace } from './EmailWorkspace.js';
import { StrictMode, useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ArrowUpRight, Check, ChevronRight, FileText, FolderOpen, Image, Leaf, LogOut, Plus, Search, X } from 'lucide-react';
import { createClient } from '@eclosion-tech/grove/client';
import type { Content, ContentType, Document, Field, Json, SchemaRecord, Scope, AdminModuleInfo } from '@eclosion-tech/grove';
import './style.css';
import { Editor, Modal, documentTitle as titleOf, documentStatus as statusOf } from './Editor.js';
import { registerContentTools } from './webmcp.js';

import { adminViews } from './admin-views.js';
import { AdminWorkspace } from './AdminWorkspace.js';
import { MediaBrowser } from '../../shared/References.js';

type Session = { scope: Scope; csrf: string; actor: string; role?: string; demoRoles?: boolean; email?: string | null; name?: string | null; login?: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';


function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [local, setLocal] = useState(false);
  const [loginUrl, setLoginUrl] = useState('');
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void fetch('/auth/session').then(async r => {
    const value = await r.json(); if (r.ok) setSession(value); else { setLocal(value.localLogin === true); setLoginUrl(typeof value.login === 'string' ? value.login : ''); }
  }).catch(e => setError(message(e))).finally(() => setReady(true)); }, []);
  async function login() {
    if (loginUrl) { location.assign(loginUrl); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/auth/login', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const value = await response.json(); if (!response.ok) throw new Error(value.error);
      setToken(''); setSession(value);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (!session) return <div className="login"><div className="login-brand"><Leaf size={36}/><span>grove<span className="brand-dot">.</span></span></div><form onSubmit={e => { e.preventDefault(); void login(); }} className="login-card">
    <span className="eyebrow">YOUR CONTENT WORKSPACE</span><h1>Make yourself<br/>at home.</h1><p>A little room to write, shape, and publish.</p>
    {!local && !loginUrl && <label>Development access token<input type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required/><small>Use GROVE_DEV_TOKEN from your local .env file.</small></label>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={!ready || busy}>{busy ? 'Opening…' : loginUrl ? 'Sign in with Syntropy' : local ? 'Open local workspace' : 'Open workspace'}<ArrowUpRight size={18}/></button>
    <small className="login-foot">{loginUrl ? 'Syntropy Grove' : 'Syntropy Grove · Local development'}</small>
  </form></div>;
  return <Workspace key={session.actor} session={session} changeRole={async role => {
    const response = await fetch(`/auth/demo-role?role=${encodeURIComponent(role)}`, { method: 'POST', headers: { 'X-Grove-CSRF': session.csrf } });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Could not change role'); setSession(value);
  }} logout={async () => {
    const response = await fetch('/auth/logout', { method: 'POST', headers: { 'X-Grove-CSRF': session.csrf } });
    if (response.ok) { setSession(null); setLocal(false); location.reload(); }
  }}/>;
}

function Workspace({ session, logout, changeRole }: { session: Session; logout: () => Promise<void>; changeRole: (role: string) => Promise<void> }) {
  const client = useMemo(() => createClient({ baseUrl: location.origin, scope: session.scope, headers: () => ({ 'X-Grove-CSRF': session.csrf }) }), [session]);
  const canCms = !session.role || session.role === 'owner';
  const [modules, setModules] = useState<AdminModuleInfo[]>([]);
  const [activeAdmin, setActiveAdmin] = useState<{ module: string; resource: string } | null>(null);
  const [moduleError, setModuleError] = useState('');
  const [registry, setRegistry] = useState<SchemaRecord | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [typeName, setTypeName] = useState('');
  const [media, setMedia] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [selected, setSelected] = useState<Document | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const navigationGuard = useRef<(() => Promise<boolean>) | null>(null);
  const registerGuard = useCallback((guard: () => Promise<boolean>) => { navigationGuard.current = guard; return () => { navigationGuard.current = null; }; }, []);
  useEffect(() => registerContentTools(async type => (await client.listDocuments({ type, limit: 100 })).map(doc => ({ id: doc.id, type: doc.type, title: titleOf(doc), status: statusOf(doc) })), async id => {
    if (navigationGuard.current && !await navigationGuard.current()) throw new Error('Resolve the current draft save issue before opening another document.');
    const doc = await client.getDocument(id);
    flushSync(() => { setEmailOpen(false); setActiveAdmin(null); setMedia(false); setTypeName(doc.type); setSelected(doc); });
    return { id: doc.id, opened: true };
  }), [client]);
  async function navigate(action: () => void) { if (!navigationGuard.current || await navigationGuard.current()) { setEmailOpen(false); action(); } }
  async function openDocument(id: string) { await navigate(() => { void client.getDocument(id).then(doc => { setEmailOpen(false); setActiveAdmin(null); setMedia(false); setTypeName(doc.type); setSelected(doc); }).catch(e => setError(message(e))); }); }
  async function loadModules() { try { const catalog = await client.adminModules(); setModules(catalog); setModuleError(''); if (!canCms && catalog[0]?.resources[0]) setActiveAdmin({ module: catalog[0].id, resource: catalog[0].resources[0].id }); } catch (e) { setModuleError(message(e)); } }
  useEffect(() => { void loadModules(); }, [client]);
  async function reload() {
    if (!canCms) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const schema = await client.getSchema(); setRegistry(schema);
      setTypeName(current => current || schema?.definition.types[0]?.name || '');
      const all: Document[] = []; let after: string | undefined;
      do { const batch = await client.listDocuments({ after, limit: 100 }); all.push(...batch); after = batch.length === 100 ? batch.at(-1)!.id : undefined; } while (after);
      setDocuments(all);
    } catch (e) { setError(message(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, [client]);
  const type = registry?.definition.types.find(t => t.name === typeName);
  const visible = documents.filter(d => d.type === typeName && titleOf(d, registry?.definition.defaultLocale).toLowerCase().includes(search.toLowerCase()) && (filter === 'All' || statusOf(d) === filter));
  const changed = (doc: Document) => { setDocuments(rows => [doc, ...rows.filter(r => r.id !== doc.id)]); setSelected(doc); };
  async function create() {
    if (!type || !registry) return;
    setBusy(true); setError('');
    try {
      const titleField = type.fields.find(f => f.name === 'title');
      const data: Content = titleField ? { title: titleField.localized ? { [registry.definition.defaultLocale]: newTitle } : newTitle } : {};
      const doc = await client.saveDocument(crypto.randomUUID(), { type: type.name, expectedRevision: 0, expectedSchemaVersion: registry.version, data });
      changed(doc); setCreating(false); setNewTitle('');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const adminModule = modules.find(m => m.id === activeAdmin?.module);
  const adminResource = adminModule?.resources.find(r => r.id === activeAdmin?.resource);
  return <div className="workspace">
    <aside className="sidebar"><a href="/" className="brand" onClick={e => { e.preventDefault(); void navigate(() => { setSelected(null); if (canCms) { setActiveAdmin(null); setMedia(false); } }); }}><Leaf size={27}/>grove<span className="brand-dot">.</span></a>
      <div className="site-switch"><div className="site-monogram">{session.scope.siteId[0]?.toUpperCase()}</div><div><strong>{session.scope.siteId}</strong><small>{session.scope.environment}</small></div></div>
      <span className="nav-caption">WORKSPACE</span>{canCms && <><button className={`nav-item ${!emailOpen && !media && !activeAdmin ? 'active' : ''}`} onClick={() => void navigate(() => { setActiveAdmin(null); setMedia(false); setSelected(null); })}><FolderOpen size={19}/>Content<span>{documents.length}</span></button>
      <button className={`nav-item ${media ? 'active' : ''}`} onClick={() => void navigate(() => { setActiveAdmin(null); setMedia(true); setSelected(null); })}><Image size={19}/>Media</button>
      {registry?.definition.types.some(t => t.name === 'email') && <button className={`nav-item email-nav ${emailOpen ? 'active' : ''}`} onClick={() => void navigate(() => { setEmailOpen(true); setMedia(false); setActiveAdmin(null); setSelected(null); })}><FileText size={19}/>Email</button>}
      <span className="nav-caption collections">COLLECTIONS</span>
      {registry?.definition.types.filter(t => t.name !== 'email').map(t => <button key={t.name} className={`collection ${t.name === typeName ? 'chosen' : ''}`} onClick={() => void navigate(() => { setActiveAdmin(null); setMedia(false); setTypeName(t.name); setSelected(null); setSearch(''); })}><span className="collection-dot"/>{t.label ?? t.name}<span>{documents.filter(d => d.type === t.name).length}</span></button>)}
      </>}{modules.length > 0 && <span className="nav-caption applications">APPLICATIONS</span>}{modules.map(module => module.resources.map(resource => <button key={`${module.id}-${resource.id}`} className={`nav-item ${activeAdmin?.module === module.id && activeAdmin.resource === resource.id ? 'active' : ''}`} onClick={() => void navigate(() => { setSelected(null); setMedia(false); setActiveAdmin({ module: module.id, resource: resource.id }); })}><FolderOpen size={18}/>{resource.label}</button>))}
      <div className="sidebar-bottom"><a className="site-link" href="/example-site/" onClick={e => { e.preventDefault(); void navigate(() => location.assign('/example-site/')); }}><ArrowUpRight size={18}/>Open example site</a>{session.demoRoles && <label className="practice-role">Practice as<select aria-label="Practice role" value={session.role ?? 'owner'} onChange={e => { const role = e.target.value; void navigate(() => { void changeRole(role).catch(e => setModuleError(message(e))); }); }}><option value="owner">Workspace owner</option><option value="coordinator">Class coordinator</option><option value="reviewer">Curriculum reviewer</option><option value="observer">Read-only observer</option></select></label>}<div className="profile"><div className="avatar">L</div><div><strong>{session.role && session.role !== 'owner' ? session.role[0]!.toUpperCase() + session.role.slice(1) : 'Local developer'}</strong><small>Syntropy Grove</small></div><button className="icon-button" aria-label="Sign out" onClick={() => void navigate(() => { void logout(); })}><LogOut size={17}/></button></div></div>
    </aside>
    <main className="main"><header className="topbar"><span>Workspace</span><ChevronRight size={14}/><strong>{emailOpen ? 'Email' : adminModule?.label ?? (media ? 'Media' : 'Content')}</strong><div className="environment"><i/>{session.scope.environment}</div></header>
      {moduleError && <p className="error" role="alert">{moduleError}<button onClick={() => void loadModules()}>Retry</button></p>}
      {emailOpen && registry ? <EmailWorkspace client={client} registry={registry} csrf={session.csrf} registerGuard={registerGuard}/> : adminModule && adminResource ? <AdminWorkspace key={`${adminModule.id}-${adminResource.id}`} client={client} module={adminModule} resource={adminResource} renderRecord={adminViews[`${adminModule.id}/${adminResource.id}`]} practice={session.demoRoles === true}/> : !canCms ? <div className="empty">{modules.length ? 'Choose an application from the sidebar.' : 'No applications are available for this account.'}</div> : media && registry ? <section className="content-view"><div className="page-heading"><div><span className="eyebrow">YOUR SHARED LIBRARY</span><h1>Media</h1><p>One image, wherever your story needs it.</p></div></div><MediaBrowser client={client} registry={registry} onOpen={id => void openDocument(id)}/></section> : selected && registry ? <Editor onOpen={id => void openDocument(id)} key={selected.id} doc={selected} registry={registry} client={client} onChange={changed} onBack={() => void navigate(() => setSelected(null))} registerGuard={registerGuard}/> : <section className="content-view">
        <div className="page-heading"><div><span className="eyebrow">YOUR WORK, GROWING</span><h1>{type?.label ?? type?.name ?? 'Content'}</h1><p>A home for everything you’re putting into the world.</p></div><button className="primary" disabled={!type} onClick={() => setCreating(true)}><Plus size={18}/>New {type?.name ?? 'content'}</button></div>
        <div className="collection-bar"><div className="filters">{['All', 'Draft', 'Published', 'Changes'].map(f => <button key={f} className={filter === f ? 'selected' : ''} onClick={() => setFilter(f)}>{f}</button>)}</div><label className="search"><Search size={17}/><input aria-label="Search content" placeholder="Find something…" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
        {error && <div className="error" role="alert">{error}<button onClick={() => void reload()}>Try again</button></div>}
        {loading ? <div className="empty">Loading your content…</div> : !registry ? <div className="empty"><FolderOpen size={32}/><h2>Ready for your first collection</h2><p>Push a schema from your client repository to begin.</p><code>npm run grove -- schema push examples/schema.ts --expected 0</code></div> : visible.length === 0 ? <div className="empty"><FileText size={32}/><h2>{search ? 'No matches yet' : 'A fresh page awaits'}</h2><p>{search ? 'Try a different title or filter.' : `Create your first ${type?.name ?? 'document'} to get started.`}</p></div> : <div className="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Last edited</th><th aria-label="Open"/></tr></thead><tbody>{visible.map(doc => <tr key={doc.id}><td><button className="document-link" onClick={() => setSelected(doc)}><span className="doc-icon"><FileText size={20}/></span><span><strong>{titleOf(doc, registry.definition.defaultLocale)}</strong><small>{typeof doc.draft.slug === 'string' ? `/${doc.draft.slug}` : type?.label ?? doc.type}</small></span></button></td><td><span className={`badge ${statusOf(doc).toLowerCase()}`}><i/>{statusOf(doc)}</span></td><td className="edited">{new Date(doc.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}<small>Local developer</small></td><td><button className="icon-button" aria-label={`Edit ${titleOf(doc)}`} onClick={() => setSelected(doc)}><ChevronRight size={18}/></button></td></tr>)}</tbody></table></div>}
        <footer className="collection-footer"><span>{visible.length} {visible.length === 1 ? 'document' : 'documents'}</span><span><Check size={14}/>Your drafts stay private until you publish.</span></footer>
      </section>}
    </main>
    {creating && <Modal title={`New ${type?.name}`} onClose={() => { if (!busy) setCreating(false); }}><form onSubmit={e => { e.preventDefault(); void create(); }}><label>Title<input autoFocus required value={newTitle} onChange={e => setNewTitle(e.target.value)}/></label>{error && <p className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}<Plus size={17}/></button></form></Modal>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
