import test from 'node:test';
import assert from 'node:assert/strict';
import {
    generateCodeVerifier,
    computeCodeChallenge,
    parseAuthCodeFromRedirect,
    shapeTokenResponse,
} from '../src/lib/auth-pkce';

const VERIFIER_CHARSET_RE = /^[A-Za-z0-9\-._~]+$/;

test('generateCodeVerifier produces a default-length verifier using only the unreserved charset', () => {
    const verifier = generateCodeVerifier();
    assert.equal(verifier.length, 128);
    assert.match(verifier, VERIFIER_CHARSET_RE);
});

test('generateCodeVerifier honors a custom length within the RFC 7636 range', () => {
    const verifier = generateCodeVerifier(43);
    assert.equal(verifier.length, 43);
    assert.match(verifier, VERIFIER_CHARSET_RE);
});

test('generateCodeVerifier produces different values across calls (uses fresh randomness)', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    assert.notEqual(a, b);
});

test('generateCodeVerifier rejects out-of-range lengths', () => {
    assert.throws(() => generateCodeVerifier(42));
    assert.throws(() => generateCodeVerifier(129));
});

test('computeCodeChallenge matches the RFC 7636 Appendix B known-answer vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await computeCodeChallenge(verifier);
    assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('parseAuthCodeFromRedirect extracts the code from the query string (not a hash fragment)', () => {
    const redirectUrl = 'https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/?code=4%2F0Adeu5B&scope=email';
    const code = parseAuthCodeFromRedirect(redirectUrl);
    assert.equal(code, '4/0Adeu5B');
});

test('parseAuthCodeFromRedirect ignores a hash fragment even if it contains an access_token', () => {
    const redirectUrl =
        'https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/?code=real-code#access_token=should-be-ignored';
    const code = parseAuthCodeFromRedirect(redirectUrl);
    assert.equal(code, 'real-code');
});

test('parseAuthCodeFromRedirect throws the error string when ?error= is present', () => {
    const redirectUrl = 'https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/?error=interaction_required';
    assert.throws(() => parseAuthCodeFromRedirect(redirectUrl), /interaction_required/);
});

test('parseAuthCodeFromRedirect propagates access_denied the same way', () => {
    const redirectUrl = 'https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/?error=access_denied';
    assert.throws(() => parseAuthCodeFromRedirect(redirectUrl), /access_denied/);
});

test('parseAuthCodeFromRedirect throws when neither code nor error is present', () => {
    const redirectUrl = 'https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/?scope=email';
    assert.throws(() => parseAuthCodeFromRedirect(redirectUrl), /no_auth_code/);
});

test('shapeTokenResponse converts a token endpoint response into a shaped token', () => {
    const now = 1_700_000_000_000;
    const shaped = shapeTokenResponse({ access_token: 'atk', expires_in: 3600, refresh_token: 'rtk' }, now);
    assert.equal(shaped.token, 'atk');
    assert.equal(shaped.expiresAt, now + 3600 * 1000);
    assert.equal(shaped.refreshToken, 'rtk');
});

test('shapeTokenResponse defaults expires_in to 3600s and omits refreshToken when absent', () => {
    const now = 1_700_000_000_000;
    const shaped = shapeTokenResponse({ access_token: 'atk' }, now);
    assert.equal(shaped.expiresAt, now + 3600 * 1000);
    assert.equal(shaped.refreshToken, undefined);
});

test('shapeTokenResponse throws the error code when access_token is missing (e.g. invalid_grant)', () => {
    assert.throws(() => shapeTokenResponse({ error: 'invalid_grant' }), /invalid_grant/);
});
