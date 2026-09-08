import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, RefreshCw } from 'lucide-react';
import type { AdminActionInfo, AdminColumn, AdminExecution, AdminInput, AdminModuleInfo, AdminRecordView, AdminResourceInfo, Content } from '@eclosion-tech/grove';
import type { createClient } from '@eclosion-tech/grove/client';
import { Modal } from './Editor.js';
import './admin.css';
type Client = ReturnType<typeof createClient>;
const message = (e: unknown) => e instanceof Error ? e.message : 'Could not load this workspace.';
const display = (value: unknown) => value === null || value === undefined || value === '' ? '—' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : typeof value === 'object' ? JSON.stringify(value) : String(value);
function Value({ column, value }: { column: AdminColumn; value: unknown }) { return column.type === 'status' ? <span className={`admin-status ${String(value)}`}>{display(value).replaceAll('-', ' ')}</span> : <span>{display(value)}</span>; }

export function AdminWorkspace({ client, module, resource, practice, renderRecord }: { renderRecord?: (record: AdminRecordView) => ReactNode; client: Client; module: AdminModuleInfo; resource: AdminResourceInfo; practice: boolean }) {
  const [filters, setFilters] = useState<Content>({}); const [rows, setRows] = useState<AdminRecordView[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0); const [selected, setSelected] = useState<AdminRecordView | null>(null); const [action, setAction] = useState<AdminActionInfo | null>(null); const [activity, setActivity] = useState<AdminExecution[]>([]); const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => { const current = ++generation.current; setLoading(true); setError(''); setRows([]); setCursor(null);
    const timer = setTimeout(() => { void client.adminQuery(module.id, resource.id, { filters }).then(page => { if (current === generation.current) { setRows(page.records); setCursor(page.nextCursor); } }).catch(e => { if (current === generation.current) setError(message(e)); }).finally(() => { if (current === generation.current) setLoading(false); }); }, 200);
    return () => { generation.current++; clearTimeout(timer); };
  }, [client, module.id, resource.id, filters, refresh]);
  async function readActivity() { try { setActivity(await client.adminActivity(module.id, resource.id)); } catch (e) { setError(message(e)); } }
  useEffect(() => { if (resource.actions.length) void readActivity(); else setActivity([]); }, [client, module.id, resource.id, resource.actions.length, refresh]);
  async function more() { const current = generation.current; setLoading(true); try { const page = await client.adminQuery(module.id, resource.id, { filters, cursor }); if (current === generation.current) { setRows(r => [...r, ...page.records]); setCursor(page.nextCursor); } } catch (e) { if (current === generation.current) setError(message(e)); } finally { if (current === generation.current) setLoading(false); } }
  async function open(row: AdminRecordView) { setError(''); try { setSelected(await client.adminGet(module.id, resource.id, row.id)); } catch (e) { setError(message(e)); } }
  async function completed(result: AdminExecution) { setNotice(result.message); setRefresh(v => v + 1); if (result.status === 'succeeded' || result.status === 'rejected') { setAction(null); if (selected) { try { setSelected(await client.adminGet(module.id, resource.id, selected.id)); } catch { setSelected(null); } } } }
  const columns = resource.columns.slice(0, 3);
  return <section className="content-view admin-workspace"><div className="page-heading"><div><span className="eyebrow">{module.label}</span><h1>{resource.label}</h1><p>{resource.description}</p></div><button disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={16}/>Refresh</button></div>
    {practice && <div className="admin-practice">Practice workspace · Sample records. Actions update this local demo only.</div>}
    <div className="admin-filters">{resource.filters.map(field => <Input key={field.name} field={field} value={filters[field.name]} onChange={value => setFilters({ ...filters, [field.name]: value })} filter/>)}</div>
    {notice && <p className="admin-notice" role="status"><Check size={16}/>{notice}<button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></p>}
    {error && <p className="error" role="alert">{error}<button onClick={() => setRefresh(v => v + 1)}>Try again</button></p>}
    {!rows.length ? <div className="empty">{loading ? 'Loading records…' : error ? 'Records could not be loaded.' : 'No records match your access and filters.'}</div> : <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c.name}>{c.label}</th>)}<th aria-label="Open record"/></tr></thead><tbody>{rows.map(row => <tr key={row.id}>{columns.map((col, index) => <td key={col.name}>{index === 0 ? <button className="document-link" onClick={() => void open(row)}><strong>{display(row.values[col.name])}</strong></button> : <Value column={col} value={row.values[col.name]}/>}</td>)}<td><button className="icon-button" aria-label={`Open ${display(row.values[columns[0]?.name ?? ''])}`} onClick={() => void open(row)}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>}
    {cursor && <button disabled={loading} onClick={() => void more()}>{loading ? 'Loading…' : 'More records'}</button>}
    {!!resource.actions.length && <section className="admin-activity"><div><h2>Your recent actions</h2><button onClick={() => void readActivity()}>Check results</button></div>{activity.length ? activity.map(item => <div className="admin-activity-row" key={item.id}><strong>{resource.actions.find(a => a.id === item.action)?.label ?? item.action}</strong><span>{item.message}</span><time>{new Date(item.createdAt).toLocaleString()}</time></div>) : <p className="muted">Your completed and pending actions will appear here.</p>}</section>}
    {selected && <Modal title={display(selected.values[resource.columns[0]?.name ?? ''])} onClose={() => { if (!action) setSelected(null); }}>{renderRecord?.(selected)}<dl className="admin-details">{resource.columns.map(col => <div key={col.name}><dt>{col.label}</dt><dd><Value column={col} value={selected.values[col.name]}/></dd></div>)}</dl><div className="button-row">{resource.actions.filter(a => selected.actions.includes(a.id)).map(a => <button className="primary" key={a.id} onClick={() => setAction(a)}>{a.label}</button>)}</div>{!selected.actions.length && <p className="muted">No actions are available for this record with your current access.</p>}<button onClick={() => void open(selected)}>Reload record</button></Modal>}
    {selected && action && <ActionDialog client={client} module={module.id} resource={resource.id} record={selected} action={action} onClose={() => setAction(null)} onResult={completed}/>}
  </section>;
}
function Input({ field, value, onChange, filter = false }: { field: AdminInput; value: unknown; onChange: (value: any) => void; filter?: boolean }) {
  return <label>{field.label}{field.options ? <select required={field.required} value={String(value ?? '')} onChange={e => onChange(e.target.value)}><option value="">{filter ? 'All' : 'Choose…'}</option>{field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : field.type === 'boolean' ? <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)}/> : !filter && field.type === 'string' ? <textarea required={field.required} maxLength={2000} rows={4} value={String(value ?? '')} onChange={e => onChange(e.target.value)}/> : <input type={field.type === 'number' ? 'number' : 'search'} step="any" required={field.required} maxLength={2000} value={String(value ?? '')} onChange={e => onChange(field.type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value)}/>}</label>;
}
function ActionDialog({ client, module, resource, record, action, onClose, onResult }: { client: Client; module: string; resource: string; record: AdminRecordView; action: AdminActionInfo; onClose: () => void; onResult: (result: AdminExecution) => void }) {
  const [values, setValues] = useState<Content>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<AdminExecution | null>(null);
  const request = useRef<{ requestId: string; recordId: string; expectedVersion: number; values: Content } | null>(null);
  const dirty = Object.values(values).some(v => v !== '' && v !== null);
  function close() { if (!busy && (!dirty || result || window.confirm('Discard the action form?'))) onClose(); }
  useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (busy || dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, [busy, dirty]);
  async function run() {
    setBusy(true); setError('');
    request.current ??= { requestId: crypto.randomUUID(), recordId: record.id, expectedVersion: record.version, values: structuredClone(values) };
    try { const next = await client.adminRun(module, resource, action.id, request.current); setResult(next); onResult(next); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Modal title={action.label} onClose={close}><p>{action.description}</p><form onSubmit={e => { e.preventDefault(); void run(); }}><fieldset disabled={busy || !!request.current}>{action.inputs.map(field => <Input key={field.name} field={field} value={values[field.name]} onChange={value => setValues(v => ({ ...v, [field.name]: value }))}/>)}</fieldset><p className="admin-confirmation">{action.confirmation}</p>{error && <p className="error" role="alert">{error}</p>}{result && <p role="status">{result.message}</p>}<div className="button-row"><button type="button" disabled={busy} onClick={close}>Close</button><button className="primary" disabled={busy}>{busy ? 'Working…' : request.current ? result ? 'Check result' : 'Retry original request' : action.label}</button></div>{request.current && <small>Retries keep the original action and values and prevent duplicate execution.</small>}</form></Modal>;
}
