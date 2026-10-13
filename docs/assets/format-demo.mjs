// Documentation helper: summarize the JSON output of the local reference trace.
import { readFileSync } from 'node:fs';
const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const row = (label, value) => console.log(label.padEnd(16) + value);
row('SCENARIO', run.scenarioId);
row('TASK', run.evaluation.taskId);
row('VERDICT', run.evaluation.verdict);
console.log('\nREFERENCE ACTIONS');
for (const step of run.trace) row(step.action.actor, step.action.tool);
console.log('\nTICKET STATE: BEFORE -> AFTER');
for (const ticket of run.after.tickets) {
 const before = run.before.tickets.find(t => t.id === ticket.id);
 row('ID', ticket.id);
 for (const key of ['title', 'assigneeId', 'status', 'version']) row(key, `${before?.[key] ?? 'unassigned'} -> ${ticket[key] ?? 'unassigned'}`);
}
console.log('\nTASK PREDICATES');
for (const r of run.evaluation.results) row(r.passed ? 'PASS' : 'FAIL', r.predicate.kind);
