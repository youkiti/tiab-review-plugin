export type SheetEditAccess = 'editable' | 'readonly' | 'unknown';

export function pickSheetAccessBanner(input: {
    editAccess: SheetEditAccess;
    deniedUnsentCount: number;
    userEmail: string;
}): { messageKey: string; args: string[] } | null {
    if (input.editAccess === 'readonly') {
        return { messageKey: 'screening_sheetReadonly', args: [input.userEmail] };
    }
    if (input.deniedUnsentCount > 0) {
        return { messageKey: 'screening_sheetDeniedUnsent', args: [String(input.deniedUnsentCount)] };
    }
    return null;
}

export function pickScreeningCompletion(total: number, unsentCount: number): {
    titleKey: string;
    titleArgs: string[];
    progressKey: string;
    progressArgs: string[];
    canCelebrate: boolean;
} {
    const hasUnsent = unsentCount > 0;
    return {
        titleKey: hasUnsent ? 'screening_tiabUnsentTitle' : 'screening_tiabDoneTitle',
        titleArgs: hasUnsent ? [String(total), String(unsentCount)] : [String(total)],
        progressKey: hasUnsent ? 'screening_progressUnsent' : 'progress_complete',
        progressArgs: hasUnsent ? [String(unsentCount)] : [],
        canCelebrate: !hasUnsent,
    };
}
