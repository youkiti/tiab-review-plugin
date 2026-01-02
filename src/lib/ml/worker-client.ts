import { MlRecord, MlState, MlWorkerMessage, MlWorkerResponse, Label, createInitialMlState } from "./types";

export class MlWorkerClient {
    private worker: Worker | null = null;
    private state: MlState = createInitialMlState();
    private listeners: Set<(state: MlState) => void> = new Set();
    private debounceTimer: any = null;
    private pendingLabels: Record<string, Label> | null = null;

    constructor() {
        this.initWorker();
    }

    private initWorker() {
        if (this.worker) return;

        // Webpack should handle this URL automatically
        this.worker = new Worker(new URL('./worker.ts', import.meta.url));

        this.worker.onmessage = (event: MessageEvent<MlWorkerResponse>) => {
            this.handleMessage(event.data);
        };

        this.worker.onerror = (err) => {
            console.error('ML Worker Error:', err);
            this.updateState({ status: 'error', errorMessage: 'Worker error occurred' });
        };
    }

    public terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }

    public subscribe(listener: (state: MlState) => void) {
        this.listeners.add(listener);
        // Send current state immediately
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    private updateState(partial: Partial<MlState>) {
        this.state = { ...this.state, ...partial, lastUpdated: Date.now() };
        this.notify();
    }

    private notify() {
        this.listeners.forEach(listener => listener(this.state));
    }

    public init(records: MlRecord[], labels: Record<string, Label>) {
        if (!this.worker) this.initWorker();

        this.updateState({ status: 'initializing' });
        this.postMessage({ type: 'init', records, labels });
    }

    public updateLabels(labels: Record<string, Label>) {
        // Debounce updates
        this.pendingLabels = labels;

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            if (this.pendingLabels && this.worker) {
                this.updateState({ status: 'training' });
                this.postMessage({ type: 'updateLabels', labels: this.pendingLabels });
                this.pendingLabels = null;
            }
        }, 300); // 300ms debounce
    }

    public reset() {
        if (this.worker) {
            this.postMessage({ type: 'reset' });
            this.updateState(createInitialMlState());
        }
    }

    private postMessage(msg: MlWorkerMessage) {
        this.worker?.postMessage(msg);
    }

    private handleMessage(msg: MlWorkerResponse) {
        switch (msg.type) {
            case 'ready':
            case 'updated':
                this.updateState({
                    status: 'ready',
                    ranking: msg.ranking,
                    labeledCount: msg.stats
                });
                break;
            case 'error':
                this.updateState({
                    status: 'error',
                    errorMessage: msg.message
                });
                break;
        }
    }

    public getState(): MlState {
        return this.state;
    }
}

// Singleton instance
export const mlClient = new MlWorkerClient();
