import { copy as zh } from './zh'
export const copy = {
  noReply: 'ローカルモデルは再試行後も回答を返しませんでした。もう一度お試しください。',
  title: 'ローカルチャットモデル',
  missing: '未ダウンロード',
  checking: 'SHA-256 を検証中…',
  downloading: 'ダウンロード中 {n}%',
  paused: '一時停止 {n}%',
  ready: '準備完了',
  error: 'エラー',
  download: 'ダウンロード',
  cancel: 'キャンセル',
  resume: '再開',
  remove: 'モデルを削除',
  keepHot: 'メモリ保持（分）',
  thinking: '推論（低速）',
  autoDownload: '必要時にモデルをダウンロード',
  advanced: '詳細設定',
  threads: 'CPU スレッド',
  gpu: 'バックエンド',
  context: 'コンテキストトークン',
  limits: 'テキストのみ。画像は未対応です。コーディング、長い会話、複雑な推論には推奨されません。',
  license:
    'LFM Open License v1.0：年間売上が1,000万 USDを超える場合は Liquid AI との別途契約が必要です。',
  gpuWarning:
    '標準は CPU。テストで Radeon 780M の Vulkan がクラッシュしました。GPU には別途互換ランタイムの導入が必要です。',
  offline: 'オフラインです。ローカルモデルのダウンロードには接続が必要です。',
  metered:
    '従量制ネットワークのため自動ダウンロードを一時停止しました。続行するには手動でダウンロードしてください。',
} satisfies Record<keyof typeof zh, string>
