export function computeBalancedSampleWeight(labels: number[], ratio: number): Float64Array {
  const weights = new Float64Array(labels.length);
  let includeCount = 0;
  let excludeCount = 0;
  for (const label of labels) {
    if (label === 1) {
      includeCount += 1;
    } else if (label === 0) {
      excludeCount += 1;
    }
  }

  if (includeCount === 0 || excludeCount === 0) {
    for (let i = 0; i < weights.length; i += 1) {
      weights[i] = 1;
    }
    return weights;
  }

  const excludeWeight = includeCount / (ratio * excludeCount);
  for (let i = 0; i < labels.length; i += 1) {
    weights[i] = labels[i] === 1 ? 1.0 : excludeWeight;
  }

  let sumWeights = 0;
  for (const w of weights) {
    sumWeights += w;
  }
  const scale = labels.length / sumWeights;
  for (let i = 0; i < weights.length; i += 1) {
    weights[i] *= scale;
  }

  return weights;
}
