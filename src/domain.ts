import { createHash } from 'node:crypto';

export type Role = 'admin' | 'member';
export type Status = 'open' | 'in_progress' | 'closed';
export type Ticket = {
  id: string; title: string; ownerId: string; assigneeId: string | null;
  status: Status; version: number; createdAt: string; updatedAt: string;
};
export type Event = {
  sequence: number; at: string; actor: string; action: string;
  before?: Ticket; after?: Ticket; details?: Record<string, unknown>;
};
export type Snapshot = {
  schemaVersion: 2; seed: string; users: Record<string, Role>;
  clockMs: number; tickMs: number; nextId: number; tickets: Ticket[];
  events: Event[]; operations: Array<{ key: string; hash: string; ticket: Ticket }>;
};
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function fail(message: string): never { throw new DomainError('invalid', message); }
export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function identifier(value: unknown, label = 'ID'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) fail(`Invalid ${label}`);
}
export function usersValid(users: unknown): asserts users is Record<string, Role> {
  if (!object(users) || !Object.keys(users).length) fail('Invalid users');
  for (const [id, role] of Object.entries(users)) {
    identifier(id, 'user ID');
    if (id === 'system' || !['admin', 'member'].includes(role)) fail('Invalid users');
  }
}
export function initialState(users: Record<string, Role>, seed: string, clockMs = 1767225600000, tickMs = 1000): Snapshot {
  usersValid(users); identifier(seed, 'seed');
  if (seed.length > 40) fail('Seed must be at most 40 characters');
  if (!Number.isSafeInteger(clockMs) || !Number.isSafeInteger(tickMs) || tickMs < 1 || !Number.isFinite(new Date(clockMs).getTime())) fail('Invalid simulation clock');
  return { schemaVersion: 2, seed, users: structuredClone(users), clockMs, tickMs, nextId: 1, tickets: [], events: [], operations: [] };
}
export interface StateStore {
  read(): Snapshot;
  transact<T>(fn: (state: Snapshot) => T): T;
  close(): void;
}
export class MemoryStore implements StateStore {
  private state: Snapshot;
  constructor(state: Snapshot) { this.state = structuredClone(state); }
  read() { return structuredClone(this.state); }
  transact<T>(fn: (state: Snapshot) => T): T {
    const copy = structuredClone(this.state), result = fn(copy);
    if (result instanceof Promise) fail('Transactions must be synchronous');
    const cloned = structuredClone(result);
    this.state = copy;
    return cloned;
  }
  close() {}
}
function authorize(state: Snapshot, actor: string, ticket?: Ticket) {
  const role = state.users[actor];
  if (!Object.hasOwn(state.users, actor) || !role || (ticket && role !== 'admin' && actor !== ticket.ownerId && actor !== ticket.assigneeId))
    throw new DomainError('forbidden', 'Actor cannot access ticket');
}
function get(state: Snapshot, actor: string, id: string): Ticket {
  authorize(state, actor);
  const ticket = state.tickets.find(t => t.id === id);
  if (!ticket) throw new DomainError('not_found', 'Unknown ticket');
  authorize(state, actor, ticket);
  return ticket;
}
function titleValid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('Title must be 1–500 characters');
}
function timestamp(state: Snapshot) {
  const at = new Date(state.clockMs).toISOString();
  if (!Number.isSafeInteger(state.clockMs + state.tickMs) || !Number.isFinite(new Date(state.clockMs + state.tickMs).getTime())) fail('Simulation clock overflow');
  state.clockMs += state.tickMs;
  return at;
}
function version(ticket: Ticket, expected: unknown) {
  if (!Number.isSafeInteger(expected) || expected !== ticket.version) throw new DomainError('conflict', 'Stale ticket version');
}
export type TicketFilter = { query?: string; status?: Status; ownerId?: string; assigneeId?: string | null; limit?: number };
export function filterTickets(tickets: Ticket[], filter: TicketFilter = {}): Ticket[] {
  if (!object(filter) || Object.keys(filter).some(k => !['query', 'status', 'ownerId', 'assigneeId', 'limit'].includes(k))) fail('Invalid filter');
  if (filter.query !== undefined && (typeof filter.query !== 'string' || filter.query.length > 500)) fail('Invalid query');
  if (filter.status !== undefined && !['open', 'in_progress', 'closed'].includes(filter.status)) fail('Invalid status filter');
  if (filter.ownerId !== undefined && typeof filter.ownerId !== 'string') fail('Invalid owner filter');
  if (filter.assigneeId !== undefined && filter.assigneeId !== null && typeof filter.assigneeId !== 'string') fail('Invalid assignee filter');
  if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 1000)) fail('Invalid search limit');
  return tickets.filter(t => (filter.query === undefined || t.title.toLowerCase().includes(filter.query.toLowerCase())) &&
    (filter.status === undefined || t.status === filter.status) && (filter.ownerId === undefined || t.ownerId === filter.ownerId) &&
    (filter.assigneeId === undefined || t.assigneeId === filter.assigneeId)).slice(0, filter.limit ?? tickets.length);
}
export class TicketEnvironment {
  private store: StateStore;
  readonly seed: string;
  constructor(users: Record<string, Role> = { alice: 'member', admin: 'admin' }, seed = 'demo', store?: StateStore) {
    this.store = store ?? new MemoryStore(initialState(users, seed));
    this.seed = this.store.read().seed;
  }
  create(actor: string, title: string, operationKey?: string): Ticket {
    return this.store.transact(state => {
      authorize(state, actor); titleValid(title);
      if (operationKey !== undefined && (typeof operationKey !== 'string' || !operationKey || operationKey.length > 200)) fail('Operation key must be 1–200 characters');
      const key = JSON.stringify([actor, operationKey]), hash = createHash('sha256').update(title.trim()).digest('hex');
      const previous = operationKey ? state.operations.find(o => o.key === key) : undefined;
      if (previous) {
        if (previous.hash !== hash) throw new DomainError('conflict', 'Operation key reused with different input');
        return previous.ticket;
      }
      const at = timestamp(state);
      const ticket: Ticket = { id: `${state.seed}-T${state.nextId++}`, title: title.trim(), ownerId: actor, assigneeId: null,
        status: 'open', version: 1, createdAt: at, updatedAt: at };
      state.tickets.push(ticket);
      state.events.push({ sequence: state.events.length + 1, at, action: 'create', actor, after: structuredClone(ticket) });
      if (operationKey) state.operations.push({ key, hash, ticket: structuredClone(ticket) });
      return ticket;
    });
  }
  list(actor: string): Ticket[] {
    const state = this.store.read(); authorize(state, actor);
    return state.tickets.filter(t => state.users[actor] === 'admin' || t.ownerId === actor || t.assigneeId === actor);
  }
  search(actor: string, filter: TicketFilter = {}) { return filterTickets(this.list(actor), filter); }
  get(actor: string, id: string) { return structuredClone(get(this.store.read(), actor, id)); }
  update(actor: string, id: string, patch: { title?: string; assigneeId?: string | null }, expectedVersion: number): Ticket {
    return this.store.transact(state => {
      const ticket = get(state, actor, id); version(ticket, expectedVersion);
      if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(k => !['title', 'assigneeId'].includes(k))) fail('Invalid update fields');
      if (ticket.status === 'closed') throw new DomainError('invalid_transition', 'Closed tickets cannot be edited');
      const before = structuredClone(ticket);
      if (patch.title !== undefined) { titleValid(patch.title); ticket.title = patch.title.trim(); }
      if (Object.hasOwn(patch, 'assigneeId')) {
        if (patch.assigneeId !== null && (typeof patch.assigneeId !== 'string' || !Object.hasOwn(state.users, patch.assigneeId))) fail('Unknown assignee');
        ticket.assigneeId = patch.assigneeId!;
      }
      ticket.version++; ticket.updatedAt = timestamp(state);
      state.events.push({ sequence: state.events.length + 1, at: ticket.updatedAt, actor, action: 'update', before, after: structuredClone(ticket) });
      return ticket;
    });
  }
  transition(actor: string, id: string, status: Status, expectedVersion: number): Ticket {
    return this.store.transact(state => {
      const ticket = get(state, actor, id); version(ticket, expectedVersion);
      const legal: Record<Status, Status[]> = { open: ['in_progress', 'closed'], in_progress: ['closed'], closed: [] };
      if (!legal[ticket.status].includes(status)) throw new DomainError('invalid_transition', 'Unsupported transition');
      const before = structuredClone(ticket);
      ticket.status = status; ticket.version++; ticket.updatedAt = timestamp(state);
      state.events.push({ sequence: state.events.length + 1, at: ticket.updatedAt, actor, action: 'transition', before, after: structuredClone(ticket) });
      return ticket;
    });
  }
  closeTicket(actor: string, id: string, expectedVersion: number) { return this.transition(actor, id, 'closed', expectedVersion); }
  advance(milliseconds: number) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail('Invalid clock advancement');
    return this.store.transact(state => {
      const next = state.clockMs + milliseconds;
      if (!Number.isSafeInteger(next) || !Number.isFinite(new Date(next).getTime())) fail('Simulation clock overflow');
      const at = new Date(state.clockMs).toISOString(); state.clockMs = next;
      state.events.push({ sequence: state.events.length + 1, at, actor: 'system', action: 'clock_advance', details: { milliseconds } });
      return state.clockMs;
    });
  }
  snapshot(): Snapshot { return this.store.read(); }
  dispose() { this.store.close(); }
}

export function validateSnapshot(value: unknown): Snapshot {
  const fields = ['schemaVersion','seed','users','clockMs','tickMs','nextId','tickets','events','operations'];
  if (!object(value) || value.schemaVersion !== 2 || fields.some(k => !Object.hasOwn(value,k)) || Object.keys(value).some(k => !fields.includes(k))) fail('Unsupported snapshot schema');
  if (!Number.isSafeInteger(value.clockMs) || !Number.isSafeInteger(value.tickMs)) fail('Invalid simulation clock');
  initialState(value.users, value.seed, value.clockMs, value.tickMs);
  if (!Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.tickets) || !Array.isArray(value.events) || !Array.isArray(value.operations)) fail('Invalid snapshot collections');
  const ids = new Set<string>();
  for (const [position, ticket] of value.tickets.entries()) {
    if (!object(ticket) || Object.keys(ticket).sort().join(',') !== ['id','title','ownerId','assigneeId','status','version','createdAt','updatedAt'].sort().join(',')) fail('Invalid snapshot ticket');
    identifier(ticket.id, 'ticket ID'); titleValid(ticket.title);
    if (ticket.id !== `${value.seed}-T${position + 1}`) fail('Invalid generated ticket sequence');
    if (ids.has(ticket.id) || !Object.hasOwn(value.users, ticket.ownerId) || (ticket.assigneeId !== null && !Object.hasOwn(value.users, ticket.assigneeId)) || !['open','in_progress','closed'].includes(ticket.status) || !Number.isSafeInteger(ticket.version) || ticket.version < 1) fail('Invalid snapshot ticket state');
    if (![ticket.createdAt,ticket.updatedAt].every(x => typeof x === 'string' && Number.isFinite(Date.parse(x)))) fail('Invalid ticket timestamp');
    ids.add(ticket.id);
  }
  const replay = new Map<string, Ticket>();
  let previousTime = -Infinity;
  for (let i = 0; i < value.events.length; i++) {
    const event = value.events[i];
    if (!object(event) || event.sequence !== i + 1 || typeof event.actor !== 'string' || (event.actor !== 'system' && !Object.hasOwn(value.users,event.actor)) || typeof event.action !== 'string' || !Number.isFinite(Date.parse(event.at))) fail('Invalid event history');
    const instant = Date.parse(event.at);
    if (instant < previousTime || instant > value.clockMs) fail('Invalid event clock order');
    previousTime = instant;
    if (event.action === 'clock_advance') {
      if (event.actor !== 'system' || event.before !== undefined || event.after !== undefined || !object(event.details) || !Number.isSafeInteger(event.details.milliseconds) || event.details.milliseconds < 0) fail('Invalid clock event');
      continue;
    }
    if (!['create','update','transition'].includes(event.action) || !object(event.after) || !ids.has(event.after.id)) fail('Invalid ticket event');
    const after = event.after as Ticket, before = replay.get(after.id);
    if (Object.keys(after).sort().join(',') !== ['id','title','ownerId','assigneeId','status','version','createdAt','updatedAt'].sort().join(',')) fail('Invalid event ticket fields');
    titleValid(after.title);
    if (!Object.hasOwn(value.users,after.ownerId) || (after.assigneeId !== null && !Object.hasOwn(value.users,after.assigneeId)) || !['open','in_progress','closed'].includes(after.status) || !Number.isSafeInteger(after.version) || after.updatedAt !== event.at || !Number.isFinite(Date.parse(after.createdAt))) fail('Invalid event ticket state');
    if (event.action === 'create') {
      if (before || event.before !== undefined || after.version !== 1 || after.status !== 'open' || after.ownerId !== event.actor || after.assigneeId !== null || after.createdAt !== event.at) fail('Invalid create event');
    } else {
      if (!before || JSON.stringify(before) !== JSON.stringify(event.before) || before.version + 1 !== after.version || before.ownerId !== after.ownerId || before.createdAt !== after.createdAt || before.status === 'closed') fail('Event history does not replay');
      authorize(value as Snapshot, event.actor, before);
      if (event.action === 'update' && before.status !== after.status) fail('Update changed lifecycle');
      if (event.action === 'transition' && (before.title !== after.title || before.assigneeId !== after.assigneeId || !(before.status === 'open' ? ['in_progress','closed'] : ['closed']).includes(after.status))) fail('Invalid transition event');
    }
    replay.set(after.id, after);
  }
  if (value.tickets.some((ticket:Ticket) => JSON.stringify(replay.get(ticket.id)) !== JSON.stringify(ticket))) fail('Snapshot tickets disagree with event history');
  const keys = new Set<string>();
  for (const operation of value.operations) {
    if (!object(operation) || typeof operation.key !== 'string' || keys.has(operation.key) || !/^[a-f0-9]{64}$/.test(operation.hash) || !object(operation.ticket) || !ids.has(operation.ticket.id)) fail('Invalid idempotency history');
    let key:unknown;
    try { key = JSON.parse(operation.key); } catch { fail('Invalid operation key'); }
    if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || typeof key[1] !== 'string' || !key[1] || key[1].length > 200 || operation.key !== JSON.stringify(key) || operation.ticket.ownerId !== key[0] || typeof operation.ticket.title !== 'string' || createHash('sha256').update(operation.ticket.title.trim()).digest('hex') !== operation.hash || !value.events.some((event:Event) => event.action === 'create' && JSON.stringify(event.after) === JSON.stringify(operation.ticket))) fail('Idempotency result disagrees with create history');
    keys.add(operation.key);
  }
  if (value.nextId !== value.tickets.length + 1) fail('Snapshot next ID does not match ticket sequence');
  return structuredClone(value) as Snapshot;
}
