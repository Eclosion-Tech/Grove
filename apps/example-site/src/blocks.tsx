import { createContext, useContext, useEffect, useState } from 'react';
import type { Config } from '@puckeditor/core';
import type { Content, DeliveredDocument, SchemaRecord, MediaAsset, AssetReference } from '@eclosion-tech/grove';
import DOMPurify from 'dompurify';
import type { Blocks } from './manifest.js';

import { ReferenceInput, type Client } from '../../shared/References.js';
export const GroveFields = createContext<{ client: Client; registry: SchemaRecord } | null>(null);
function RecordField({ value, onChange, image = false }: { value: any; onChange: (value: any) => void; image?: boolean }) {
  const context = useContext(GroveFields);
  return context ? <ReferenceInput {...context} value={value} onChange={onChange} to={['article']} image={image}/> : <p>Sign in to choose content.</p>;
}
export const SiteMode = createContext<'live' | 'preview'>('live');
export async function readContent(id: string, mode: 'live' | 'preview'): Promise<DeliveredDocument> {
  const response = await fetch(`/example-api/content/${encodeURIComponent(id)}?mode=${mode}`, { credentials: 'same-origin' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? 'Content could not be loaded.');
  return value;
}
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return String((value as Content).en ?? '');
  return '';
}
export function ArticleBody({ content }: { content: Content }) {
  return <article className="article-body"><span className="kicker">FIELDNOTES JOURNAL</span><h1>{text(content.title)}</h1><p className="article-summary">{text(content.summary)}</p><Author value={content.author}/><SiteImage image={content.coverImage as AssetReference | null}/><div className="plain-prose">{text(content.body).split('\n\n').map((p, i) => <p key={i}>{p}</p>)}</div></article>;
}
function ArticleCard({ article, label }: Blocks['Article']) {
  const documentId = article?._ref;
  const mode = useContext(SiteMode);
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setContent(null); setError('');
    if (!documentId) return;
    void readContent(documentId, mode).then(result => { if (active) setContent(result.data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [documentId, mode]);
  return <section className="article-card"><span className="kicker">{label}</span>{!documentId ? <p>Choose a journal story to feature here.</p> : error ? <p>{error}</p> : content ? <><h2>{text(content.title)}</h2><p>{text(content.summary)}</p><a href={`/example-site/?id=${encodeURIComponent(documentId ?? '')}&mode=${mode}`}>Read the story <span>↗</span></a></> : <p>Loading story…</p>}</section>;
}

export const config: Config<Blocks> = {
  categories: { content: { title: 'Make it yours', components: ['Hero', 'Prose', 'Image'] }, connected: { title: 'From your content', components: ['Article'] } },
  root: { render: ({ children }) => <div className="fieldnotes-page"><nav className="site-nav"><a href="/example-site/" className="site-wordmark">fieldnotes<span>®</span></a><span>A space for ideas in progress.</span></nav>{children}<footer className="site-footer"><span>Keep noticing. Keep making.</span><a href="/">Made with Grove ↗</a></footer></div> },
  components: {
    Hero: {
      label: 'Opening statement',
      fields: { eyebrow: { type: 'text', label: 'Eyebrow' }, title: { type: 'textarea', label: 'Heading' }, description: { type: 'textarea', label: 'Introduction' }, tone: { type: 'radio', label: 'Color', options: [{ label: 'Forest', value: 'forest' }, { label: 'Paper', value: 'paper' }] } },
      defaultProps: { eyebrow: 'A JOURNAL OF SMALL DISCOVERIES', title: 'Something worth sharing.', description: 'Make room for a new idea.', tone: 'forest' },
      render: ({ eyebrow, title, description, tone }) => <section className={`site-hero ${tone}`}><span className="kicker">{eyebrow}</span><h1>{title}</h1><p>{description}</p><span className="hero-marker" aria-hidden="true">01 — FIELDNOTES</span></section>,
    },
    Prose: {
      label: 'Rich text', fields: { body: { type: 'richtext', label: 'Text', contentEditable: false } },
      defaultProps: { body: '<h2>A thought to begin with.</h2><p>Write something worth paying attention to.</p>' },
      render: ({ body }) => <section className="site-prose" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(typeof body === 'string' ? body : '', { USE_PROFILES: { html: true }, FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] }) }}/>,
    },
    Image: { label: 'Image', fields: { image: { type: 'custom', label: 'Library image', render: ({ value, onChange }) => <RecordField value={value} onChange={onChange} image/> } }, defaultProps: { image: null }, render: ({ image }) => <SiteImage image={image}/> },
    Article: {
      label: 'Journal story', fields: { article: { type: 'custom', label: 'Journal story', render: ({ value, onChange }) => <RecordField value={value} onChange={onChange}/> }, label: { type: 'text', label: 'Eyebrow' } },
      defaultProps: { article: null, label: 'FROM THE JOURNAL' },
      render: props => <ArticleCard {...props}/>,
    },
  },
};

function Author({ value }: { value: unknown }) {
  const mode = useContext(SiteMode); const [name, setName] = useState('');
  const id = value && typeof value === 'object' && '_ref' in value ? String(value._ref) : '';
  useEffect(() => { let active = true; setName(''); if (id) void readContent(id, mode).then(doc => { if (active) setName(text(doc.data.title)); }).catch(() => {}); return () => { active = false; }; }, [id, mode]);
  return <small>{id ? name : text(value)}</small>;
}
function SiteImage({ image }: { image: AssetReference | null | undefined }) {
  const mode = useContext(SiteMode); const [asset, setAsset] = useState<MediaAsset | null>(null); const [error, setError] = useState(''); const id = image?._ref;
  const url = `/example-api/media/${encodeURIComponent(id ?? '')}?mode=${mode}`;
  useEffect(() => { let active = true; setAsset(null); setError(''); if (id) void fetch(`${url}&metadata=1`).then(async r => { if (!r.ok) throw new Error('Image unavailable'); return r.json(); }).then(value => { if (active) setAsset(value); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [id, mode]);
  if (!id) return null;
  return <figure className="site-image">{error ? <p>{error}</p> : asset ? <><img src={url} alt={asset.alt.en ?? ''} width={asset.width} height={asset.height} style={{ objectPosition: `${asset.focalPoint.x * 100}% ${asset.focalPoint.y * 100}%` }}/>{asset.caption.en && <figcaption>{asset.caption.en}</figcaption>}</> : <p>Loading image…</p>}</figure>;
}
