import type { Config } from '@puckeditor/core';
import type { ReactNode } from 'react';
import { blockHtml, type EmailBlock } from './index.js';

/** Host supplies its authorized media picker and preview URLs. The document and
 * renderer stay identical across Grove and other hosts. */
export function createEmailConfig(options: { imageField: (props: any) => ReactNode; imageUrl: (id: string) => string; color?: string }): Config<any> {
const fields: Record<string, any> = {
  Heading: { text: { type: 'textarea', label: 'Heading' } },
  Text: { body: { type: 'richtext', label: 'Message', contentEditable: false } },
  Image: { image: { type: 'custom', label: 'Library image', render: options.imageField }, alt: { type: 'text', label: 'Image description' } },
  Button: { label: { type: 'text', label: 'Button text' }, href: { type: 'text', label: 'Destination (https://)' } },
  Divider: {}, Columns: { left: { type: 'richtext', label: 'Left column', contentEditable: false }, right: { type: 'richtext', label: 'Right column', contentEditable: false } },
};
const defaults: Record<string, any> = { Heading: { text: 'Something worth sharing.' }, Text: { body: '<p>Add your message here.</p>' }, Image: { image: null, alt: '' }, Button: { label: 'Find out more', href: '' }, Divider: {}, Columns: { left: '<p>First story.</p>', right: '<p>Second story.</p>' } };
return {
  categories: { content: { title: 'Build your email', components: Object.keys(fields) } },
  root: { fields: { brand: { type: 'text', label: 'Organization' }, color: { type: 'text', label: 'Brand color (#245343)' }, address: { type: 'textarea', label: 'Mailing address' } }, render: ({ children, brand, address, color }: any) => <div style={{ background: '#fff', maxWidth: 600, margin: '0 auto', borderTop: `5px solid ${/^#[0-9a-f]{6}$/i.test(color) ? color : '#245343'}` }}><div style={{ padding: 32, font: 'bold 18px Arial' }}>{brand}</div>{children}<footer style={{ padding: 32, background: '#f8f8f6', font: '12px/1.6 Arial', color: '#666' }}>{brand}<br/>{address || 'Add your mailing address in email settings.'}<br/><span style={{ textDecoration: 'underline' }}>Unsubscribe</span></footer></div> },
  components: Object.fromEntries(Object.keys(fields).map(type => [type, { label: type === 'Columns' ? 'Two columns' : type, fields: fields[type], defaultProps: defaults[type], render: (props: any) => <div style={{ padding: '12px 32px', fontFamily: 'Arial, sans-serif', color: '#292a28' }} dangerouslySetInnerHTML={{ __html: blockHtml({ type: type as EmailBlock['type'], props }, options.color ?? '#245343', props.image?._ref ? { [props.image._ref]: options.imageUrl(props.image._ref) } : {}) }}/> }])),
};
}
