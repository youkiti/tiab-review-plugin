import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSIGNMENT_SETUP_TOUR, assignmentSetupConditions, type AssignmentSetupInput } from '../src/lib/guide/tours/assignment-setup';
import { availableTours, nextStepIndex } from '../src/lib/guide/tour-progress';

const base: AssignmentSetupInput = {
    view: 'screening',
    currentTab: 'screening',
    spreadsheetId: 'sheet-1',
    isAdmin: true,
    configured: false,
    assignmentSetCount: 0,
    wizardOpen: false,
};

test('assignment-setup: プロジェクトに接続していて管理者でないときだけ、使えない', () => {
    assert.equal(assignmentSetupConditions(base)['not-admin-connected'], false);
    assert.equal(assignmentSetupConditions({ ...base, isAdmin: false })['not-admin-connected'], true);
    // プロジェクト選択画面では管理者かどうかが未定なので、使えないとは扱わない
    assert.equal(assignmentSetupConditions({ ...base, view: 'project', spreadsheetId: '', isAdmin: false })['not-admin-connected'], false);
    assert.equal(assignmentSetupConditions({ ...base, view: 'project', isAdmin: false })['not-admin-connected'], false);
});

test('assignment-setup: 使えないときは availableTours から外れ、管理者なら残る', () => {
    const platform = { platform: 'extension' as const, capabilities: { createProject: true } };
    const ids = (isAdmin: boolean): string[] =>
        availableTours(platform, undefined, assignmentSetupConditions({ ...base, isAdmin }))
            .map((tour) => tour.id);
    assert.equal(ids(true).includes('assignment-setup'), true);
    assert.equal(ids(false).includes('assignment-setup'), false);
});

test('assignment-setup: 手動タブ以外では「手動タブを開く」手順から始まり、手動タブなら設定を開く手順から', () => {
    const first = (input: AssignmentSetupInput): string | undefined => {
        const index = nextStepIndex(ASSIGNMENT_SETUP_TOUR, 0, assignmentSetupConditions(input));
        return index === null ? undefined : ASSIGNMENT_SETUP_TOUR.steps[index].id;
    };
    assert.equal(first({ ...base, currentTab: 'llm' }), 'open-manual-tab');
    assert.equal(first(base), 'open-settings');
    // 設定画面やウィザードがすでに開いていれば、タブ・設定を開く手順は飛ばす
    assert.equal(first({ ...base, currentTab: 'llm', view: 'settings' }), 'banner');
    assert.equal(first({ ...base, currentTab: 'llm', wizardOpen: true }), 'wizard-numbers');
});

test('assignment-setup: 管理者でない人は、管理者向けの手順を全部飛ばして案内の手順に着く', () => {
    const input = { ...base, isAdmin: false, currentTab: 'llm', configured: true, assignmentSetCount: 3 };
    const index = nextStepIndex(ASSIGNMENT_SETUP_TOUR, 0, { ...assignmentSetupConditions(input), 'on-screening-screen': true });
    assert.equal(index === null ? undefined : ASSIGNMENT_SETUP_TOUR.steps[index].id, 'not-admin');
    // 管理者ならこの案内は出ない
    const admin = assignmentSetupConditions({ ...input, isAdmin: true });
    assert.equal(admin['admin-or-unconnected'], true);
});

test('assignment-setup: 作成後に手動タブ以外へ戻っていれば、担当セットの前に手動タブへ戻る手順が出る', () => {
    const input = { ...base, configured: true, assignmentSetCount: 3, currentTab: 'llm' };
    const from = ASSIGNMENT_SETUP_TOUR.steps.findIndex((step) => step.id === 'back-to-manual-tab');
    const index = nextStepIndex(ASSIGNMENT_SETUP_TOUR, from, assignmentSetupConditions(input));
    assert.equal(index === null ? undefined : ASSIGNMENT_SETUP_TOUR.steps[index].id, 'back-to-manual-tab');
    const onManual = nextStepIndex(ASSIGNMENT_SETUP_TOUR, from, assignmentSetupConditions({ ...input, currentTab: 'screening' }));
    assert.equal(onManual === null ? undefined : ASSIGNMENT_SETUP_TOUR.steps[onManual].id, 'sets');
});
