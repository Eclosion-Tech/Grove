import { decodeHTML } from 'entities';
import sanitizeHtml from 'sanitize-html';

export const manifestVersion = 1;
export type Asset = { _type: 'asset'; _ref: string };
export type EmailBlock = { type: 'Heading' | 'Text' | 'Image' | 'Button' | 'Divider' | 'Columns'; props: { id: string; [key: string]: unknown } };
export type EmailLayout = { root: { props: { brand: string; color: string; address: string } }; content: EmailBlock[] };
export type EmailDocument = { title: string; subject: string; previewText: string; manifestVersion: number; layout: EmailLayout };
export const emailDocumentType = {
  name: 'email', label: 'Email drafts', fields: [
    { name: 'title', type: 'string' as const, required: true },
    { name: 'subject', type: 'string' as const, required: true },
    { name: 'previewText', type: 'string' as const },
    { name: 'manifestVersion', type: 'number' as const, required: true, default: 1 },
    { name: 'layout', type: 'json' as const, required: true },
  ],
};
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function richText(value: string): string {
  return sanitizeHtml(value, { allowedTags: ['p', 'br', 'strong', 'em', 'u', 'a', 'ul', 'ol', 'li'], allowedAttributes: { a: ['href'] }, allowedSchemes: ['https', 'mailto'], allowProtocolRelative: false, transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, style: 'color:inherit;text-decoration:underline' } }) } });
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.length <= max;
export function validLink(value: unknown): value is string {
  if (!bounded(value, 2048)) return false;
  try { const url = new URL(value); return ['https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
export function validateEmail(value: unknown, send = false): asserts value is EmailDocument {
  if (!object(value) || value.manifestVersion !== 1 || !bounded(value.title, 255) || !bounded(value.subject, 500) || !bounded(value.previewText, 200)) throw new Error('Invalid email details or unsupported component version.');
  if (/[\r\n]/.test(value.subject)) throw new Error('Subject must be one line.');
  const layout = value.layout;
  if (!object(layout) || !object(layout.root) || !object(layout.root.props) || !Array.isArray(layout.content) || layout.content.length > 100) throw new Error('An email can contain up to 100 blocks.');
  const root = layout.root.props;
  if (!bounded(root.brand, 120) || !bounded(root.address, 500) || typeof root.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(root.color)) throw new Error('Check your brand name, color, and mailing address.');
  if (send && (!value.subject.trim() || !value.title.trim() || !root.brand.trim() || !root.address.trim() || !layout.content.length)) throw new Error('Add a title, subject, brand, mailing address, and email content before sending.');
  const ids = new Set<string>();
  for (const block of layout.content) {
    if (!object(block) || !object(block.props) || !bounded(block.props.id, 100) || !block.props.id || ids.has(block.props.id)) throw new Error('Each email block needs a unique ID.');
    ids.add(block.props.id); const p = block.props;
    switch (block.type) {
      case 'Heading': if (!bounded(p.text, 500)) throw new Error('Invalid heading.'); break;
      case 'Text': if (!bounded(p.body, 20000)) throw new Error('Text is too long.'); break;
      case 'Columns': if (!bounded(p.left, 10000) || !bounded(p.right, 10000)) throw new Error('Column text is too long.'); break;
      case 'Button': if (!bounded(p.label, 100) || (p.href !== '' && !validLink(p.href)) || (send && !validLink(p.href))) throw new Error('Buttons need an HTTPS or email link.'); break;
      case 'Image':
        if (!bounded(p.alt, 500) || (p.image !== null && (!object(p.image) || p.image._type !== 'asset' || !bounded(p.image._ref, 100)))) throw new Error('Choose an image from your library.');
        if (send && (!p.image || !p.alt.trim())) throw new Error('Choose an image and describe it for readers.'); break;
      case 'Divider': break;
      default: throw new Error('Unsupported email block.');
    }
  }
  // Personalization is deliberately small and has identical code and GUI semantics.
  const tokens = JSON.stringify(value).match(/\{\{[^{}]+\}\}/g) ?? [];
  if (tokens.some(t => !['{{subscriber.name}}', '{{subscriber.email}}'].includes(t))) throw new Error('Use subscriber.name or subscriber.email for personalization.');
}
export function blockHtml(block: EmailBlock, color: string, images: Record<string, string> = {}): string {
  const p = block.props;
  switch (block.type) {
    case 'Heading': return `<h1 style="margin:0 0 16px;font-size:30px;line-height:1.2;color:${color}">${escapeHtml(String(p.text))}</h1>`;
    case 'Text': return `<div style="font-size:16px;line-height:1.65">${richText(String(p.body))}</div>`;
    case 'Columns': return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="stack" width="50%" valign="top" style="padding-right:16px;font-size:16px;line-height:1.6">${richText(String(p.left))}</td><td class="stack" width="50%" valign="top" style="font-size:16px;line-height:1.6">${richText(String(p.right))}</td></tr></table>`;
    case 'Button': return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${color}" style="border-radius:4px;padding:14px 24px"><a href="${escapeHtml(validLink(p.href) ? p.href : '#')}" style="color:#fff;text-decoration:none;font-weight:bold;display:inline-block">${escapeHtml(String(p.label))}</a></td></tr></table>`;
    case 'Image': { const id = (p.image as Asset | null)?._ref; return id && images[id] ? `<img src="${escapeHtml(images[id]!)}" alt="${escapeHtml(String(p.alt))}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0"/>` : '<div style="padding:32px;background:#eee;text-align:center;color:#666">Choose a library image</div>'; }
    case 'Divider': return '<hr style="border:0;border-top:1px solid #ddd;margin:8px 0"/>';
  }
}
export function renderEmail(document: EmailDocument, images: Record<string, string> = {}) {
  validateEmail(document);
  const { brand, color, address } = document.layout.root.props;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.subject)}</title><style>@media(max-width:600px){.stack{display:block!important;width:100%!important;padding:0!important}}</style></head><body style="margin:0;background:#f3f2ef;color:#292a28;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(document.previewText)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 8px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:white"><tr><td style="padding:32px;font-size:18px;font-weight:bold;border-top:5px solid ${color}">${escapeHtml(brand)}</td></tr>${document.layout.content.map(b => `<tr><td style="padding:0 32px 24px">${blockHtml(b, color, images)}</td></tr>`).join('')}<tr><td style="padding:24px 32px;background:#f8f8f6;font-size:12px;line-height:1.6;color:#666">${escapeHtml(brand)}<br>${escapeHtml(address)}<br><a href="{{unsubscribe_url}}" style="color:#666">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
  const body = document.layout.content.map(b => b.type === 'Image' ? String(b.props.alt) : b.type === 'Button' ? `${b.props.label}: ${b.props.href}` : b.type === 'Divider' ? '—' : b.type === 'Heading' ? String(b.props.text) : [b.props.body ?? b.props.left, b.props.right].filter(Boolean).map(v => sanitizeHtml(String(v).replace(/<\/(p|li)>|<br\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })).join('\n')).join('\n\n');
  return { html, text: `${brand}\n\n${decodeHTML(body)}\n\n${address}\nUnsubscribe: {{unsubscribe_url}}` };
}
export function starter(kind = 'newsletter', brand = 'Your organization'): EmailDocument {
  const heading = kind === 'class' ? 'Make room for something new.' : kind === 'event' ? 'We hope to see you there.' : 'A little news worth sharing.';
  return { title: kind === 'class' ? 'Class announcement' : kind === 'event' ? 'Event reminder' : 'Newsletter', subject: '', previewText: '', manifestVersion: 1, layout: { root: { props: { brand, color: '#245343', address: '' } }, content: [
    { type: 'Heading', props: { id: 'opening', text: heading } },
    { type: 'Text', props: { id: 'message', body: '<p>Hello {{subscriber.name}},</p><p>Share your news here.</p>' } },
    { type: 'Button', props: { id: 'action', label: kind === 'class' ? 'Explore the class' : 'Find out more', href: '' } },
  ] } };
}
