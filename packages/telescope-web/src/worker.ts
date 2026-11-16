import { handle } from '@astrojs/cloudflare/handler';

import { reconcileAgentJobs } from './lib/agents/controller';
import { processForwarding } from './lib/forwarding/service';
import { maintainStoredResults } from './lib/storage/resultStore';

/** Reconciles durable jobs/outbox records even when no browser or agent is polling. */
export async function runMaintenance(bindings: Env): Promise<void> {
  const outcomes = await Promise.allSettled([
    reconcileAgentJobs(),
    processForwarding(undefined, bindings),
    maintainStoredResults(bindings),
  ]);
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'rejected') {
      console.error(
        JSON.stringify({
          event: 'maintenance_failed',
          task: [
            'agent_reconciliation',
            'upload_forwarding',
            'result_recovery',
          ][index],
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message.slice(0, 300)
              : 'Unknown maintenance error',
        }),
      );
    }
  }
}

const worker = {
  fetch: handle,
  scheduled(_controller, bindings, context) {
    context.waitUntil(runMaintenance(bindings));
  },
} satisfies ExportedHandler<Env>;

export { worker as default };
