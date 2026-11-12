// Pure comparison of ONNX sidecar output against the stored MLX reference.
// No I/O here: the CLI (parity.mjs) loads the files, this module only compares.

/**
 * @param {Record<string, {category: string, confidence: number, probabilities: Record<string, number>}>} reference
 * @param {Record<string, {category: string, confidence: number, probabilities: Record<string, number>}>} observed
 * @param {{minAgreement: number, confidenceDrift?: number}} opts
 */
export function compareParity(reference, observed, opts) {
  const drift = opts.confidenceDrift ?? 0.05;
  const keys = Object.keys(reference);
  const disagree = [];
  const missing = [];
  let agree = 0;
  let maxProbDelta = 0;
  let driftCount = 0;
  for (const key of keys) {
    const ref = reference[key];
    const obs = observed[key];
    if (!obs) {
      missing.push(key);
      continue;
    }
    if (obs.category === ref.category) agree += 1;
    else disagree.push(key);
    if (Math.abs(obs.confidence - ref.confidence) > drift) driftCount += 1;
    const cats = new Set([...Object.keys(ref.probabilities), ...Object.keys(obs.probabilities)]);
    for (const c of cats) {
      const d = Math.abs((obs.probabilities[c] ?? 0) - (ref.probabilities[c] ?? 0));
      if (d > maxProbDelta) maxProbDelta = d;
    }
  }
  const total = keys.length;
  const rate = total === 0 ? 0 : agree / total;
  const pass = missing.length === 0 && total > 0 && rate >= opts.minAgreement;
  return {
    total,
    agree,
    disagree,
    missing,
    pass,
    rate,
    maxProbDelta,
    confidenceDriftCount: driftCount,
  };
}
