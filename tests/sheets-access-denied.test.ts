import test from 'node:test';
import assert from 'node:assert/strict';
import { isSheetsAccessDeniedStatus, SheetsAccessDeniedError } from '../src/lib/sheets-api';

test('isSheetsAccessDeniedStatus classifies Picker-remediable statuses', () => {
    assert.equal(isSheetsAccessDeniedStatus(403), true);
    assert.equal(isSheetsAccessDeniedStatus(404), true);
    assert.equal(isSheetsAccessDeniedStatus(401), false);
    assert.equal(isSheetsAccessDeniedStatus(500), false);
});

test('SheetsAccessDeniedError carries spreadsheet id and status', () => {
    const error = new SheetsAccessDeniedError('abc123', 404, 'not found');
    assert.equal(error.name, 'SheetsAccessDeniedError');
    assert.equal(error.spreadsheetId, 'abc123');
    assert.equal(error.status, 404);
    assert.equal(error.message, 'not found');
});
