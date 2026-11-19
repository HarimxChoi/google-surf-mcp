import type { KnowledgeJobRecord, KnowledgeJobView } from './contracts.js';

export function jobView(job: KnowledgeJobRecord): KnowledgeJobView {
  const { affected_source_ids, request: _request, ...summary } = job;
  const elapsed = Math.max(0, Date.parse(job.updated_at) - Date.parse(job.created_at));
  return { ...summary, affected_source_count: affected_source_ids.length, elapsed_ms: elapsed,
    ...(job.status === 'queued' ? { waiting_reason: job.stage ? 'checkpointed_or_waiting_for_worker' : 'waiting_for_worker' } : {}),
    ...(elapsed > 0 && job.completed_items ? { items_per_second: job.completed_items / (elapsed / 1000) } : {}),
    sources: { action: 'job_sources', job_id: job.job_id, offset: 0, limit: 100 } };
}
