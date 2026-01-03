export function getMlClientVersion(suffix: string): string {
    const manifestVersion = chrome?.runtime?.getManifest?.().version;
    const baseVersion = manifestVersion || 'unknown';
    return `${baseVersion}${suffix}`;
}
