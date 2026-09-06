/** セクション内の折りたたみカードを、同じヘッダーに重複登録せず配線する。 */
export function wireCollapsibleCards(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>('.llm-card.collapsible .collapsible-header').forEach(header => {
        if (header.dataset['collapsibleWired'] === 'true') return;
        header.dataset['collapsibleWired'] = 'true';
        header.addEventListener('click', (e) => {
            // ヘルプアイコンのクリックでは折りたたまない
            if ((e.target as HTMLElement)?.closest('.help-icon')) {
                return;
            }
            const card = header.closest('.llm-card.collapsible');
            card?.classList.toggle('collapsed');
        });
    });
}
