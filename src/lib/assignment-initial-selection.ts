// assignment-initial-selection.ts - TiAb 担当セットの初期選択を決める純関数

export function initialSelectedAssignmentSets(options: {
    configured: boolean;
    isAdmin: boolean;
    availableSets: Set<string>;
    assignedSets: Set<string>;
}): Set<string> {
    const { configured, isAdmin, availableSets, assignedSets } = options;
    if (!isAdmin) {
        return configured ? new Set(assignedSets) : new Set<string>();
    }

    const hasAssignedGroup = Array.from(assignedSets).some((setId) =>
        setId.startsWith('group-') && availableSets.has(setId));
    if (!hasAssignedGroup) {
        return new Set(availableSets);
    }

    const selected = new Set(Array.from(assignedSets).filter((setId) => availableSets.has(setId)));
    if (availableSets.has('unassigned')) {
        selected.add('unassigned');
    }
    return selected;
}
