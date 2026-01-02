export function queryMax(proba: Float64Array): number[] {
  const indices = Array.from({ length: proba.length }, (_, i) => i);
  indices.sort((a, b) => {
    const diff = proba[b] - proba[a];
    if (diff !== 0) {
      return diff;
    }
    return a - b;
  });
  return indices;
}
