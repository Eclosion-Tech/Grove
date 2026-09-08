import { mkdir, writeFile } from 'node:fs/promises';
import { Grove, createPostgresDatabase, migrate } from '@eclosion-tech/grove/server';
import schema from '../examples/studio-schema.js';
import { seedAdminDemo } from '../apps/grove/src/admin-demo.js';
import { upgradeDemo } from './upgrade-demo.js';
import { reference, type Content } from '@eclosion-tech/grove';

const db = createPostgresDatabase(process.env.DATABASE_URL!);
const grove = new Grove(db, () => true);
const ctx = { actor: { id: 'example-seed' }, scope: { tenantId: process.env.GROVE_TENANT ?? 'local', siteId: process.env.GROVE_SITE ?? 'fieldnotes', environment: 'development' } };
try {
  await migrate(db);
  await seedAdminDemo(db, ctx.scope);
  const existing = await grove.getSchema(ctx);
  if (existing) {
    // Keep the exact pre-migration envelopes locally before upgrading this demo.
    const documents = []; let after: string | undefined;
    do { const batch = await grove.listDocuments(ctx, { after, limit: 100 }); documents.push(...batch); after = batch.length === 100 ? batch.at(-1)!.id : undefined; } while (after);
    if (documents.some(d => (d.type === 'article' && [d.draft.author, d.published?.author].some(v => typeof v === 'string')) || (d.type === 'page' && [d.draft.manifestVersion, d.published?.manifestVersion].includes(1)))) {
      await mkdir('.grove/backups', { recursive: true, mode: 0o700 });
      const file = `.grove/backups/before-relationships-${Date.now()}.json`;
      await writeFile(file, JSON.stringify({ scope: ctx.scope, registry: existing, documents }, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(`Saved pre-migration content to ${file}`);
    }
    await upgradeDemo(grove, ctx);
    const latest = await grove.getSchema(ctx);
    if (latest && !latest.definition.types.some(t => t.name === 'email')) await grove.pushSchema(ctx, { ...latest.definition, types: [...latest.definition.types, schema.types.find(t => t.name === 'email')!] }, latest.version); console.log('Existing workspace preserved; demo relationships upgraded.');
  }
  else {
    await grove.pushSchema(ctx, schema, 0);
    await grove.saveDocument(ctx, 'fieldnotes-team', { type: 'author', expectedRevision: 0, expectedSchemaVersion: 1, data: { title: 'The Fieldnotes team' } });
    await grove.publish(ctx, 'fieldnotes-team', 1);
    const articles: { id: string; title: string; summary: string; published: boolean; body: string }[] = [
      { id: 'a-home-for-good-ideas', title: 'A home for good ideas', summary: 'A few words about what we’re making, and why we’re making it.', published: true, body: 'Good ideas deserve room to take shape. Fieldnotes is our space to share the work in progress, the questions worth asking, and the things we learn along the way.\n\nStart small. Be thoughtful. Keep going.' },
      { id: 'the-case-for-slower-publishing', title: 'The case for slower publishing', summary: 'Less noise. More considered words.', published: false, body: 'There is something to be said for letting a draft sit overnight. Distance makes the unnecessary words easier to spot, and the important ones easier to hear.' },
      { id: 'notes-from-the-studio', title: 'Notes from the studio', summary: 'Small observations from a week of making things.', published: true, body: 'This week, we made space for the unfinished. A sketch on the wall. A sentence with a question mark. A conversation that took us somewhere unexpected.' },
      { id: 'making-space-for-whats-next', title: 'Making space for what’s next', summary: 'A new season, and a few open questions.', published: false, body: 'What would we make if we had a little more room? That is the question we are carrying into the next season.' },
    ];
    for (const article of articles) {
      const data: Content = { title: { en: article.title }, summary: { en: article.summary }, body: { en: article.body }, slug: article.id, author: reference('fieldnotes-team', 'author') };
      await grove.saveDocument(ctx, article.id, { type: 'article', expectedRevision: 0, expectedSchemaVersion: 1, data });
      if (article.published) await grove.publish(ctx, article.id, 1);
    }
    await grove.saveDocument(ctx, 'home', { type: 'page', expectedRevision: 0, expectedSchemaVersion: 1, data: {
      title: 'Home', locale: 'en', manifestVersion: 2,
      layout: { root: { props: {} }, content: [
        { type: 'Hero', props: { id: 'hero-home', eyebrow: 'A JOURNAL OF SMALL DISCOVERIES', title: 'Good things take a little room.', description: 'Ideas in progress. Notes from the studio. A place to pay attention.', tone: 'forest' } },
        { type: 'Prose', props: { id: 'prose-home', body: '<h2>Welcome to Fieldnotes.</h2><p>We’re interested in the work between the big moments. The sketches, the conversations, the small discoveries that slowly add up to something worth sharing.</p>' } },
        { type: 'Article', props: { id: 'article-home', article: reference('a-home-for-good-ideas', 'article'), label: 'FROM THE JOURNAL' } },
      ] },
    } });
    await grove.publish(ctx, 'home', 1);
    console.log('Fieldnotes example content created.');
  }
} finally { await db.close(); }
