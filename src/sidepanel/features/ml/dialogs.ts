/**
 * モーダル操作ヘルパー
 */
export interface ModalOptions {
    title: string;
    body: string | HTMLElement;
    footer?: HTMLElement;
    onClose?: () => void;
}

const elements = {
    backdrop: () => document.getElementById('modal-backdrop') as HTMLElement,
    title: () => document.getElementById('modal-title') as HTMLElement,
    body: () => document.getElementById('modal-body') as HTMLElement,
    footer: () => document.getElementById('modal-footer') as HTMLElement,
    closeBtn: () => document.getElementById('modal-close-btn') as HTMLElement,
};

let currentOnClose: (() => void) | undefined;

export function initModal() {
    const closeBtn = elements.closeBtn();
    if (closeBtn) {
        closeBtn.onclick = () => hideModal();
    }
}

export function showModal(options: ModalOptions) {
    const backdrop = elements.backdrop();
    const title = elements.title();
    const body = elements.body();
    const footer = elements.footer();

    title.textContent = options.title;

    body.innerHTML = '';
    if (typeof options.body === 'string') {
        body.innerHTML = options.body;
    } else {
        body.appendChild(options.body);
    }

    footer.innerHTML = '';
    if (options.footer) {
        footer.appendChild(options.footer);
    }

    currentOnClose = options.onClose;
    backdrop.classList.remove('hidden');
}

export function hideModal() {
    const backdrop = elements.backdrop();
    backdrop.classList.add('hidden');

    if (currentOnClose) {
        currentOnClose();
        currentOnClose = undefined;
    }
}
