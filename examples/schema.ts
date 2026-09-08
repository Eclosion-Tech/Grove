import { defineSchema } from '@eclosion-tech/grove';

export default defineSchema({
  locales: ['en', 'es'],
  defaultLocale: 'en',
  types: [{
    name: 'article', label: 'Articles',
    fields: [
      { name: 'title', type: 'string', localized: true, required: true },
      { name: 'slug', type: 'string', required: true },
      { name: 'summary', type: 'text', localized: true },
      { name: 'featured', type: 'boolean', default: false },
    ],
  }],
});
