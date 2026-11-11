import test from 'node:test';
import assert from 'node:assert/strict';

function createLoadingTask() {
    let reject!: (reason: unknown) => void;
    const promise = new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
    });
    let destroyCalls = 0;
    return {
        promise,
        reject,
        get destroyCalls() { return destroyCalls; },
        async destroy() {
            destroyCalls++;
            reject(new Error('読み込みタスクを破棄しました'));
        },
    };
}

test('PDF読み込み: 文献切り替えと破棄による失敗は空の結果を返し、現在の失敗は伝播する', async () => {
    // PDF.js と拡張APIだけを差し替え、実際の文書や worker を使わず競合を再現する。
    const modulePath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const rendererPath = require.resolve('../src/fulltext/pdf-renderer');
    const originalModule = require.cache[modulePath];
    const originalRenderer = require.cache[rendererPath];
    const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const tasks: ReturnType<typeof createLoadingTask>[] = [];
    require.cache[modulePath] = {
        exports: {
            GlobalWorkerOptions: {},
            getDocument: () => {
                const task = createLoadingTask();
                tasks.push(task);
                return task;
            },
        },
    } as NodeModule;
    Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { runtime: { getURL: (path: string) => path } },
    });
    try {
        const { PdfRenderer } = require('../src/fulltext/pdf-renderer') as typeof import('../src/fulltext/pdf-renderer');
        const renderer = new PdfRenderer({ innerHTML: '' } as HTMLElement);
        const empty = { numPages: 0, isImageOnly: false, totalTextLength: 0 };
        const first = renderer.loadPdf(new Uint8Array());
        const second = renderer.loadPdf(new Uint8Array());
        assert.deepEqual(await first, empty);
        assert.equal(tasks[0].destroyCalls, 1);

        const error = new Error('現在の文書の読み込みに失敗しました');
        tasks[1].reject(error);
        await assert.rejects(second, actual => actual === error);

        const third = renderer.loadPdf(new Uint8Array());
        renderer.destroy();
        assert.deepEqual(await third, empty);
        assert.equal(tasks[2].destroyCalls, 1);
    } finally {
        if (originalModule) require.cache[modulePath] = originalModule;
        else delete require.cache[modulePath];
        if (originalRenderer) require.cache[rendererPath] = originalRenderer;
        else delete require.cache[rendererPath];
        if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});
