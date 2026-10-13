export * from './domain.ts';
export * from './scenarios.ts';
export * from './storage.ts';
export * from './http.ts';
export * from './mcp.ts';
import { TicketEnvironment } from './domain.ts';
export function runDemo() {
  const env = new TicketEnvironment();
  const ticket = env.create('alice', 'Payment failed', 'order-1');
  env.transition('alice', ticket.id, 'closed', ticket.version);
  return env.snapshot();
}
