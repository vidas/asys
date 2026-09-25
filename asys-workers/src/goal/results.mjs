import { requiredString } from '../values.mjs';

export function implementationResult(result) {
  if (!['continue', 'review'].includes(result.goal_status)) {
    throw new Error('Implementation needs goal_status: continue or review');
  }
  return result;
}

function evidence(items, label) {
  if (!Array.isArray(items) || !items.length) throw new Error(`${label} needs observed evidence`);
  for (const item of items) {
    requiredString(item?.source, `${label} evidence source`);
    requiredString(item?.observation, `${label} evidence observation`);
  }
}

export function verification(result) {
  if (!['complete', 'gap', 'unverified'].includes(result.coverage)) {
    throw new Error('Verification needs coverage: complete, gap or unverified');
  }
  if (!Array.isArray(result.criteria) || !result.criteria.length) throw new Error('Verification needs a nonempty criteria list');
  const criteria = result.criteria.map((item, index) => {
    const label = `Criterion ${index + 1}`;
    requiredString(item?.requirement, `${label} requirement`);
    requiredString(item.basis, `${label} basis`);
    if (!['satisfied', 'unmet', 'unverified'].includes(item.status)) throw new Error(`Invalid status for ${label}`);
    const observations = item.evidence ?? [];
    if (!Array.isArray(observations)) throw new Error(`${label} evidence must be a list`);
    if (item.status === 'unverified' && !observations.length) requiredString(item.explanation, `${label} evidence gap`);
    else evidence(observations, label);
    return { ...item, satisfied: item.status === 'satisfied', evidence: observations };
  });
  return { final: result.final, criteria, coverage: result.coverage,
    verified: result.coverage === 'complete' && criteria.every(item => item.satisfied) && result.verified !== false };
}
