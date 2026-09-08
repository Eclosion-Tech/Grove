import type { Data } from '@puckeditor/core';
import type { Content, RecordReference, AssetReference } from '@eclosion-tech/grove';

/** Site-owned contract. Breaking changes require a migration here, not execution inside Grove. */
export const manifest = { version: 2, richText: 'html', components: ['Hero', 'Prose', 'Article', 'Image'] } as const;
export type Blocks = {
  Hero: { eyebrow: string; title: string; description: string; tone: 'forest' | 'paper' };
  Prose: { body: string };
  Article: { article: RecordReference | null; label: string };
  Image: { image: AssetReference | null };
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateLayout(data: unknown): asserts data is Data<Blocks> {
  if (!object(data) || !object(data.root) || !Array.isArray(data.content) || data.content.length > 100) throw new Error('This page has an invalid composition. Export it from Grove and review its data.');
  const ids = new Set();
  for (const block of data.content) {
    if (!object(block) || !object(block.props) || typeof block.props.id !== 'string' || !block.props.id || ids.has(block.props.id)) throw new Error('Every page block needs a unique, stable ID.');
    ids.add(block.props.id);
    const props = block.props;
    const required = block.type === 'Hero' ? ['eyebrow', 'title', 'description', 'tone'] : block.type === 'Prose' ? ['body'] : block.type === 'Article' ? ['label'] : block.type === 'Image' ? [] : null;
    if (!required || required.some(key => typeof props[key] !== 'string')) throw new Error(`Unsupported component or properties: ${String(block.type)}`);
    if (block.type === 'Article' && props.article !== null && (!object(props.article) || props.article._type !== 'reference' || props.article._target !== 'article' || typeof props.article._ref !== 'string')) throw new Error('Choose an article from your content.');
    if (block.type === 'Image' && props.image !== null && (!object(props.image) || props.image._type !== 'asset' || typeof props.image._ref !== 'string')) throw new Error('Choose an image from your library.');
    if (block.type === 'Hero' && !['forest', 'paper'].includes(block.props.tone as string)) throw new Error('Unknown hero theme.');
  }
}
export function readPage(content: Content): Data<Blocks> {
  if (content.manifestVersion !== manifest.version) throw new Error('This page needs a component migration before this site can open it.');
  validateLayout(content.layout);
  return content.layout;
}
