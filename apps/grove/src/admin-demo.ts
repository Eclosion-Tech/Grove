import type { AdminModule, Database, Context } from '@eclosion-tech/grove/server';
import { AdminActionRejected } from '@eclosion-tech/grove/server';
import type { AdminRecord, Scope } from '@eclosion-tech/grove';

const keys = (scope: Scope) => [scope.tenantId, scope.siteId, scope.environment];
const scoped = 'tenant_id=$1 AND site_id=$2 AND environment=$3';
const sameScope = (a: Scope, b: Scope) => JSON.stringify(keys(a)) === JSON.stringify(keys(b));
const record = (row: any): AdminRecord => ({ id: row.id, version: row.version, values: { ...row.data, assignedTo: row.assigned_to } });

/** Application-owned demo data; deliberately no Grove documents or schema-registry dependency. */
export async function seedAdminDemo(db: Database, scope: Scope) {
  await db.query('CREATE SCHEMA IF NOT EXISTS grove_demo');
  await db.query(`CREATE TABLE IF NOT EXISTS grove_demo.records (
    tenant_id text NOT NULL,site_id text NOT NULL,environment text NOT NULL,
    module_id text NOT NULL,resource_id text NOT NULL,id text NOT NULL,
    version integer NOT NULL DEFAULT 1,data jsonb NOT NULL,assigned_to text NOT NULL,
    PRIMARY KEY (tenant_id,site_id,environment,module_id,resource_id,id)
  )`);
  const fixtures = [
    ['registrations', 'roster', 'reg-01', 'demo-coordinator', { title: 'Alex Morgan', course: 'Supporting everyday transitions', email: 'alex@example.test', status: 'pending', note: 'Requested an afternoon session.' }],
    ['registrations', 'roster', 'reg-02', 'demo-coordinator', { title: 'Sam Rivera', course: 'Supporting everyday transitions', email: 'sam@example.test', status: 'confirmed', note: 'Seat already confirmed.' }],
    ['registrations', 'roster', 'reg-03', 'another-coordinator', { title: 'Jordan Lee', course: 'Building stronger routines', email: 'jordan@example.test', status: 'pending', note: 'Assigned to another coordinator.' }],
    ['curriculum', 'reviews', 'lesson-01', 'demo-reviewer', { title: 'Recognizing a learning objective', subject: 'Curriculum foundations', status: 'pending', content: 'A useful learning objective describes what a learner will be able to do. Compare “understand feedback” with “give one specific example of constructive feedback.”', feedback: '', internalNote: 'Sample generation output for local review.' }],
    ['curriculum', 'reviews', 'lesson-02', 'demo-reviewer', { title: 'Making room for practice', subject: 'Lesson design', status: 'pending', content: 'After introducing a concept, offer a short task that lets the learner apply it. Keep the first task focused on one decision, then provide specific feedback.', feedback: '', internalNote: 'Review the example before approving.' }],
    ['curriculum', 'reviews', 'lesson-03', 'another-reviewer', { title: 'Planning a follow-up activity', subject: 'Lesson design', status: 'approved', content: 'Return to an earlier concept through a new example so learners can practice transferring what they know.', feedback: '', internalNote: 'Assigned to another reviewer.' }],
  ] as const;
  for (const [module, resource, id, assigned, data] of fixtures) await db.query(`INSERT INTO grove_demo.records (tenant_id,site_id,environment,module_id,resource_id,id,assigned_to,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`, [...keys(scope), module, resource, id, assigned, data]);
}

export function demoAdminModules(db: Database, workspace: Scope): AdminModule[] {
  function source(module: string, resource: string) {
    const canSee = (ctx: Context, row: AdminRecord) => sameScope(ctx.scope, workspace) && (['local-developer', 'demo-observer'].includes(ctx.actor.id) || row.values.assignedTo === ctx.actor.id);
    return {
      async query(ctx: Context, { filters, cursor, limit }: { filters: Record<string, any>; cursor: string | null; limit: number }) {
        if (!sameScope(ctx.scope, workspace)) return { records: [], nextCursor: null };
        const rows = await db.query(`SELECT * FROM grove_demo.records WHERE ${scoped} AND module_id=$4 AND resource_id=$5 AND id>$6
          AND ($7::boolean OR assigned_to=$8) AND strpos(lower(data->>'title'),lower($9))>0 AND ($10='' OR data->>'status'=$10) ORDER BY id LIMIT $11`, [...keys(ctx.scope), module, resource, cursor ?? '', ['local-developer', 'demo-observer'].includes(ctx.actor.id), ctx.actor.id, filters.search ?? '', filters.status ?? '', limit + 1]);
        return { records: rows.slice(0, limit).map(record), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
      },
      async get(ctx: Context, id: string) {
        if (!sameScope(ctx.scope, workspace)) return null;
        const [row] = await db.query(`SELECT * FROM grove_demo.records WHERE ${scoped} AND module_id=$4 AND resource_id=$5 AND id=$6`, [...keys(ctx.scope), module, resource, id]);
        return row ? record(row) : null;
      },
      authorizeRecord: (ctx: Context, row: AdminRecord, _operation: string) => canSee(ctx, row),
    };
  }
  function transition(module: string, resource: string, status: string) {
    return async (ctx: Context, input: { record: AdminRecord; expectedVersion: number; values: Record<string, any>; operationId: string }) => {
      if (!sameScope(ctx.scope, workspace)) throw new AdminActionRejected();
      await db.transaction(async tx => {
        const [row] = await tx.query(`SELECT * FROM grove_demo.records WHERE ${scoped} AND module_id=$4 AND resource_id=$5 AND id=$6 FOR UPDATE`, [...keys(ctx.scope), module, resource, input.record.id]);
        // Business rules are enforced where the data lives, even if another application changes it during preflight.
        if (!row || row.version !== input.expectedVersion || row.data.status !== 'pending' || (ctx.actor.id !== 'local-developer' && row.assigned_to !== ctx.actor.id)) throw new AdminActionRejected();
        await tx.query(`UPDATE grove_demo.records SET data=$7::jsonb,version=version+1 WHERE ${scoped} AND module_id=$4 AND resource_id=$5 AND id=$6`, [...keys(ctx.scope), module, resource, row.id, { ...row.data, status, ...(input.values.feedback ? { feedback: input.values.feedback } : {}) }]);
      });
    };
  }
  const filters = (statuses: string[]) => [
    { name: 'search', label: 'Search by name', type: 'string' as const },
    { name: 'status', label: 'Status', type: 'string' as const, options: statuses.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1).replaceAll('-', ' ') })) },
  ];
  return [
    { id: 'registrations', label: 'Registrations', description: 'Manage class rosters and review pending seats.', resources: [{
      id: 'roster', label: 'Class roster', description: 'Review registrations and confirm seats for your assigned classes.', permission: 'admin:registrations:read', filters: filters(['pending', 'confirmed']),
      columns: [{ name: 'title', label: 'Participant', type: 'text' }, { name: 'course', label: 'Class', type: 'text' }, { name: 'status', label: 'Status', type: 'status' }, { name: 'email', label: 'Email', type: 'text', permission: 'admin:registrations:personal' }, { name: 'note', label: 'Staff note', type: 'text', permission: 'admin:registrations:personal' }],
      source: source('registrations', 'roster'), actions: [{ id: 'confirm', label: 'Confirm seat', description: 'Mark this registration as confirmed.', confirmation: 'Confirm this participant’s seat? This updates the local practice roster immediately.', inputs: [], permission: 'admin:registrations:confirm', available: (_ctx, record) => record.values.status === 'pending', execute: transition('registrations', 'roster', 'confirmed') }],
    }] },
    { id: 'curriculum', label: 'Curriculum', description: 'Review learning materials before they are approved.', resources: [{
      id: 'reviews', label: 'Lesson reviews', description: 'Read sample lessons, approve them, or request a revision with feedback.', permission: 'admin:curriculum:read', filters: filters(['pending', 'approved', 'needs-revision']),
      columns: [{ name: 'title', label: 'Lesson', type: 'text' }, { name: 'subject', label: 'Subject', type: 'text' }, { name: 'status', label: 'Status', type: 'status' }, { name: 'content', label: 'Lesson text', type: 'text' }, { name: 'feedback', label: 'Review feedback', type: 'text' }, { name: 'internalNote', label: 'Review note', type: 'text', permission: 'admin:curriculum:review' }],
      source: source('curriculum', 'reviews'), actions: [
        { id: 'approve', label: 'Approve lesson', description: 'Mark this lesson as approved for the practice curriculum.', confirmation: 'Approve this lesson? This updates its review status immediately.', inputs: [], permission: 'admin:curriculum:review', available: (_ctx, record) => record.values.status === 'pending', execute: transition('curriculum', 'reviews', 'approved') },
        { id: 'revise', label: 'Request revision', description: 'Record what needs to change before the lesson can be approved.', confirmation: 'Request a revision with this feedback?', inputs: [{ name: 'feedback', label: 'What needs to change?', type: 'string', required: true }], permission: 'admin:curriculum:review', available: (_ctx, record) => record.values.status === 'pending', execute: transition('curriculum', 'reviews', 'needs-revision') },
      ],
    }] },
  ];
}
