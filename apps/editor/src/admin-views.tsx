import type { ReactNode } from 'react';
import type { AdminRecordView } from '@eclosion-tech/grove';

/** Trusted views are bundled by the host; no client-supplied scripts are evaluated. */
export const adminViews: Record<string, (record: AdminRecordView) => ReactNode> = {
  'curriculum/reviews': record => <article className="admin-lesson-preview" aria-label="Lesson preview"><span>LESSON PREVIEW</span><h2>{String(record.values.title ?? '')}</h2><p>{String(record.values.content ?? '')}</p></article>,
};
