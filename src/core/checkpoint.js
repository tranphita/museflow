export const jobMediaPrefix = jobId => `job:${jobId}:`;
export const isJobMediaKey = key => String(key).startsWith('job:');

export function staleMediaKeys(allKeys, keepKeys) {
  return allKeys.filter(key => !keepKeys.has(key) && !isJobMediaKey(key));
}

export function lockFinishedSteps(workflow) {
  for (const node of workflow.nodes || [])
    if (node.data?.status === 'success' && node.data.asset?.url) node.data.locked = true;
  return workflow;
}
