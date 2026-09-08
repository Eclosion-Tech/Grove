import { defineSchema } from '@eclosion-tech/grove';
import { emailDocumentType } from '@eclosion-tech/grove-email';
import articleSchema from './schema.js';

export default defineSchema({
  ...articleSchema,
  types: [
    emailDocumentType,
    { ...articleSchema.types[0], fields: [
      ...articleSchema.types[0].fields.map(field => ({ ...field, label: field.name[0]!.toUpperCase() + field.name.slice(1) })),
      { name: 'body', label: 'Body', type: 'text', localized: true },
      { name: 'author', label: 'Author', type: 'reference', to: ['author'] },
      { name: 'relatedArticles', label: 'Related stories', type: 'reference', to: ['article'], multiple: true },
      { name: 'coverImage', label: 'Cover image', type: 'image' },
    ] },
    { name: 'author', label: 'Authors', fields: [
      { name: 'title', label: 'Name', type: 'string', required: true },
      { name: 'bio', label: 'Biography', type: 'text', localized: true },
      { name: 'portrait', label: 'Portrait', type: 'image' },
    ] },
    { name: 'page', label: 'Pages', fields: [
      { name: 'title', label: 'Page title', type: 'string', required: true },
      { name: 'locale', label: 'Page language', type: 'string', required: true, default: 'en' },
      { name: 'manifestVersion', label: 'Component version', type: 'number', required: true, default: 2 },
      { name: 'layout', label: 'Page composition', type: 'json', required: true, default: { root: { props: {} }, content: [] } },
    ] },
  ],
});
