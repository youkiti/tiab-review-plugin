/** 担当セットの既定値と、文献の所属セットの純粋な判定。 */
import type { AssignmentConfig, Reference } from './types';

export const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

export function resolveReferenceAssignmentSet(ref: Reference, assignmentConfig: AssignmentConfig): string {
    const normalized = (ref.screening_set || '').trim();
    if (normalized) {
        return normalized;
    }
    return assignmentConfig.status === 'configured' ? 'unassigned' : '';
}
