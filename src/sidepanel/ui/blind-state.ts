/** 確定済みのキー開封状態に対応する表示文言のキーを返す。 */
export function blindStateLabelKey(isKeyOpened: boolean): 'blind_stateOpened' | 'blind_stateClosed' {
    return isKeyOpened ? 'blind_stateOpened' : 'blind_stateClosed';
}
