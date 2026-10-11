export const jobMediaPrefix = jobId => `job:${jobId}:`;
export const isJobMediaKey = key => String(key).startsWith('job:');

export function staleMediaKeys(allKeys, keepKeys) {
  return allKeys.filter(key => !keepKeys.has(key) && !isJobMediaKey(key));
}

const SERIES_TIMELINE_KEYS = ['subtitles', 'clipAudio', 'music'];

export function applySeriesSettings(checkpoint, fresh) {
  const freshTimeline = fresh.nodes?.find(node => node.type === 'timeline');
  const subtitles = new Map(
    (fresh.nodes || [])
      .filter(node => node.type === 'voiceover' && node.data?.subtitle)
      .map(node => [node.data.sceneLabel, node.data.subtitle]),
  );
  for (const node of checkpoint.nodes || []) {
    if (node.type === 'voiceover') {
      const subtitle = subtitles.get(node.data?.sceneLabel);
      if (subtitle) node.data.subtitle = subtitle;
      else delete node.data.subtitle;
    }
    if (node.type === 'timeline' && freshTimeline)
      for (const key of SERIES_TIMELINE_KEYS)
        if (freshTimeline.data?.[key] !== undefined) node.data[key] = freshTimeline.data[key];
        else delete node.data[key];
  }
  return checkpoint;
}

export function lockFinishedSteps(workflow) {
  for (const node of workflow.nodes || [])
    if (node.data?.status === 'success' && node.data.asset?.url) node.data.locked = true;
  return workflow;
}
