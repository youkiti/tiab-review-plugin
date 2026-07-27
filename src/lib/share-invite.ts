/**
 * 共有招待メッセージの組み立てヘルパー
 *
 * `sidepanel/features/sharing.ts`（招待文コピー・共有時のDrive通知メール本文）から
 * 共通利用する純粋関数群。DOM に依存しないため、ここに切り出してテスト容易性を確保する
 * （sharing.ts は dom/state 等のDOM依存モジュールを import しており、単体テストに不向きなため）。
 */
import { t } from './i18n';

/**
 * プロジェクトのスプレッドシートを開く編集用URLを組み立てる
 */
export function buildSpreadsheetUrl(spreadsheetId: string): string {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

/**
 * 招待文（インストール手順・スプレッドシートURL・操作ガイド）を組み立てる。
 * 既存ロケール文字列 share_inviteTemplate を再利用する。
 */
export function buildInviteMessage(spreadsheetId: string): string {
    return t('share_inviteTemplate', buildSpreadsheetUrl(spreadsheetId));
}
