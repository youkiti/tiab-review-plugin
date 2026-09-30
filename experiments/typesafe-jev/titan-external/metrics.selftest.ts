import assert from 'node:assert/strict';
import { medianIqr, operatingPointAtRecall } from './metrics';

const items = [0.9, 0.5, 0.5, 0.1].map((p, i) => ({ include_probability: p, label_included: i < 2 ? 1 : 0 }));
const expected = { threshold: 0.5, screened: 3, achieved_recall: 1, specificity: 0.5,
    work_saved_at_recall: 0.25, wss_at_recall: 0.20 };
assert.deepEqual(operatingPointAtRecall(items, 0.95), expected);
assert.deepEqual(operatingPointAtRecall([...items].reverse(), 0.95), expected);
for (const [n, r, required] of [[100, 99, 99], [10, 95, 10], [20, 95, 19]]) {
    const rows = Array.from({ length: n }, (_, i) => ({ label_included: 1, include_probability: (n - i) / n }));
    assert.equal(operatingPointAtRecall(rows, r / 100)!.screened, required);
}
assert.deepEqual(medianIqr([1, 2, 3, 4]), { median: 2.5, q1: 1.75, q3: 3.25 });
assert.equal(operatingPointAtRecall([], 0.95), null);
assert.equal(operatingPointAtRecall([{ label_included: 0, include_probability: 0.5 }], 0.95), null);
assert.deepEqual(medianIqr([]), { median: null, q1: null, q3: null });
assert.throws(() => operatingPointAtRecall(items, 0.955));
console.log('OK');
