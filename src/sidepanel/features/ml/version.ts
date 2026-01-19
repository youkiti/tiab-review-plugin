import { getClientVersion } from '../../../lib/client-version';

export function getMlClientVersion(suffix: string): string {
    return getClientVersion(suffix);
}
