export function queryMax(proba: Float64Array): number[] {
  const indices = Array.from({ length: proba.length }, (_, i) => i);
  indices.sort((a, b) => proba[b] - proba[a]);
  return indices;
}
