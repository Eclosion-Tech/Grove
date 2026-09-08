import type { Content, Document, Json, SchemaRecord } from './schema.js';
import { GroveClientError, type createClient } from './client.js';

type Client = Pick<ReturnType<typeof createClient>, 'saveDocument' | 'getDocument' | 'getSchema' | 'publish' | 'unpublish' | 'restore'>;
export type EditingState = {
  document: Document;
  registry: SchemaRecord;
  data: Content;
  status: 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';
  error: string;
  invalid: string[];
  busy: boolean;
};
const ordered = (value: unknown): string => Array.isArray(value) ? `[${value.map(ordered)}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${ordered((value as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(value) ?? 'undefined';
export const sameContent = (left: unknown, right: unknown) => ordered(left) === ordered(right);

/** Browser-safe lifecycle controller shared by structured and Puck editors. */
export class EditingSession {
  private state: EditingState;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight: Promise<Document | null> | null = null;
  private generation = 0;
  private stopped = false;
  constructor(private client: Client, document: Document, registry: SchemaRecord, private delay = 900) {
    this.state = { document, registry, data: structuredClone(document.draft), status: 'saved', error: '', invalid: [], busy: false };
  }
  getSnapshot = (): EditingState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private emit(patch: Partial<EditingState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  get dirty() { return !sameContent(this.state.data, this.state.document.draft); }
  get unsettled() { return this.dirty || !!this.inFlight || this.state.busy || this.state.invalid.length > 0; }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.stopped && !['conflict', 'error'].includes(this.state.status) && !this.state.invalid.length) this.timer = setTimeout(() => { void this.save(); }, this.delay);
  }
  setField(name: string, value: Json) {
    if (this.state.busy) return;
    this.generation++;
    this.emit({ data: { ...this.state.data, [name]: structuredClone(value) }, status: this.state.status === 'conflict' ? 'conflict' : this.inFlight ? 'saving' : 'unsaved', error: this.state.status === 'conflict' ? this.state.error : '' });
    this.schedule();
  }
  setInvalid(name: string, invalid: boolean) {
    const fields = new Set(this.state.invalid); if (invalid) fields.add(name); else fields.delete(name);
    this.emit({ invalid: [...fields] }); clearTimeout(this.timer);
    if (!invalid && this.dirty) this.schedule();
  }
  private failed(error: unknown) {
    this.emit({ status: error instanceof GroveClientError && error.status === 409 ? 'conflict' : 'error', error: error instanceof Error ? error.message : 'Could not save your changes.' });
  }
  async save(): Promise<Document | null> {
    clearTimeout(this.timer);
    if (this.inFlight) { await this.inFlight; return this.save(); }
    if (this.state.invalid.length || this.state.status === 'conflict') return null;
    const { document, registry } = this.state;
    if (!this.dirty && document.schemaVersion === registry.version) { this.emit({ status: 'saved', error: '' }); return document; }
    const type = registry.definition.types.find(t => t.name === document.type);
    if (!type) { this.emit({ status: 'error', error: 'This collection was removed from the schema. Export your draft before leaving.' }); return null; }
    const generation = this.generation;
    const data: Content = Object.fromEntries(type.fields.filter(f => this.state.data[f.name] !== undefined).map(f => [f.name, structuredClone(this.state.data[f.name]!)]));
    this.emit({ status: 'saving', error: '' });
    this.inFlight = (async () => {
      try {
        const saved = await this.client.saveDocument(document.id, { type: document.type, expectedRevision: document.revision, expectedSchemaVersion: registry.version, data });
        this.emit({ document: saved, ...(this.generation === generation ? { data: structuredClone(saved.draft) } : {}), status: this.generation === generation ? 'saved' : 'unsaved' });
        return saved;
      } catch (error) { this.failed(error); return null; }
    })();
    const result = await this.inFlight;
    this.inFlight = null;
    if (result && this.dirty) this.schedule();
    return result;
  }
  async flush(): Promise<Document | null> {
    let result = await this.save();
    while (result && this.dirty && !this.state.invalid.length) result = await this.save();
    return this.state.invalid.length ? null : result;
  }
  async action(action: 'publish' | 'unpublish' | 'restore', targetRevision?: number): Promise<Document | null> {
    if (this.state.busy) return null;
    this.emit({ busy: true });
    try {
      const saved = await this.flush();
      if (!saved) return null;
      const result = action === 'restore'
        ? await this.client.restore(saved.id, targetRevision!, saved.revision)
        : await this.client[action](saved.id, saved.revision);
      this.emit({ document: result, data: structuredClone(result.draft), status: 'saved', error: '', invalid: [] });
      return result;
    } catch (error) { this.failed(error); return null; }
    finally { this.emit({ busy: false }); }
  }
  /** Fetching latest never changes the local draft. The caller must explicitly choose recovery. */
  async latest() {
    const [document, registry] = await Promise.all([this.client.getDocument(this.state.document.id), this.client.getSchema()]);
    if (!registry) throw new Error('The schema is no longer available.');
    return { document, registry };
  }
  recover(latest: { document: Document; registry: SchemaRecord }, keepLocal: boolean) {
    if (this.inFlight || this.state.busy) return;
    clearTimeout(this.timer);
    const localChanges = Object.fromEntries(Object.entries(this.state.data).filter(([name, value]) => !sameContent(value, this.state.document.draft[name])));
    this.generation++;
    this.emit({ document: latest.document, registry: latest.registry, data: keepLocal ? { ...latest.document.draft, ...localChanges } : structuredClone(latest.document.draft), status: 'unsaved', error: '', invalid: [] });
    // Explicit save after reviewing the result; do not immediately autosave a conflict resolution.
  }
  stop() { clearTimeout(this.timer); this.stopped = true; }
  start() { this.stopped = false; }
}
