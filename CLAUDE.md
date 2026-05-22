# 学祭実行委員 AI サポーター

## プロジェクト概要

学祭実行委員が蓄積してきた Google Drive 上の資料（MT資料・企画書・提案書・総合計画書）を、AIが自動的に参照して質問に答えるシステム。

### 解決したい課題

- 資料を探す・読む手間が大きい
- 先輩が卒業すると過去の知見が失われる
- ログインしてすぐ使えないと意味がない（手動アップロードは NG）

### 要件

- Google Drive と自動同期（手動アップロード不要）
- ログイン後すぐ質問できる
- **完全無料**で運用する

---

## 採用アーキテクチャ：カスタム RAG

```
Google Drive（資料の置き場所）
      ↓ 定期バッチ or 更新検知で自動同期
Gemini Embedding API（text-embedding-004）
      ↓ ベクトル化
Supabase pgvector（ベクトル DB）
      ↓ 類似検索
Gemini 2.0 Flash（回答生成）
      ↓
Web チャット UI（ログインして即使える）
```

### 技術スタック（全て無料枠）

| レイヤー | サービス | 無料枠 |
|---------|---------|--------|
| ドキュメント取得 | Google Drive API | 無制限 |
| 埋め込み生成 | Gemini text-embedding-004 | 1,500 リクエスト/日 |
| 回答生成 | Gemini 2.0 Flash | 1,500 リクエスト/日 |
| ベクトル DB | Supabase pgvector | 500MB ストレージ |
| ホスティング | Vercel | 無料枠で十分 |
| フロントエンド | Next.js + NextAuth.js | 無料 |

### 却下した手法と理由

| 手法 | 却下理由 |
|------|---------|
| Google NotebookLM | 資料を手動アップロードが必要。ログインして即使えない |
| Vertex AI Agent Builder | 90 日後に課金が発生する |
| Dify セルフホスト | VPS 代が発生する可能性がある |

---

## 決定事項

| 項目 | 決定内容 |
|------|---------|
| フロントエンド | Next.js |
| 認証 | Google OAuth。`〇〇.nutfes@gmail.com` パターンのみ許可（NextAuth.js でメールアドレスのサフィックスを検証） |
| 同期頻度 | 毎日自動同期（当日近くは1日複数回 MTG があるため）＋管理者による手動トリガーボタン |
| 対象 Drive | 年度ごとに Drive が分かれている。複数 Drive を登録し、年度タグを付けてインデックス |
| 検索スコープ | UI で年度を選択して絞り込み可能（「全年度」「2024年度のみ」など） |

---

## 実装ステップ（目安 2 週間）

### Week 1
1. Google Cloud Project 作成・Drive API 有効化・OAuth 設定
2. Supabase プロジェクト作成・pgvector テーブル設計（`year` カラム含む）
3. 複数 Drive からドキュメントを取得して年度タグ付きでベクトル保存するスクリプト
4. 毎日自動同期の cron ジョブ設定（GitHub Actions の schedule trigger を使用）

### Week 2
5. 質問 → 年度フィルタ → ベクトル検索 → Gemini 回答生成のパイプライン実装
6. Next.js チャット UI（年度セレクター + チャット欄）
7. NextAuth.js で `.nutfes@gmail.com` 認証
8. Vercel にデプロイ・動作確認

---

## 年度別 Drive の構成

各年度の Drive ID を設定ファイルで管理する。

```json
// config/drives.json
[
  { "year": 2024, "driveId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  { "year": 2023, "driveId": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy" },
  { "year": 2022, "driveId": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }
]
```

Supabase の `documents` テーブルに `year` カラムを持たせ、検索時に年度でフィルタリングする。

---

## 認証の実装方針

NextAuth.js の Google Provider を使用。サインイン時にメールアドレスが `.nutfes@gmail.com` で終わるか検証する。

```ts
// pages/api/auth/[...nextauth].ts
callbacks: {
  signIn({ profile }) {
    return profile.email?.endsWith(".nutfes@gmail.com") ?? false;
  }
}
```

---

## Gemini API のコスト管理・データ保護設定（重要）

### データ保護

**無料枠のままでは送信データが Google の学習に使われる可能性がある。**  
内部資料（企画書・予算・提案書）を保護するために Google Cloud の請求を有効化する。

```
1. Google Cloud プロジェクトを作成
2. 請求情報を登録（有効化するだけ）
3. そのプロジェクトで発行した API キーを使用
   → 「Paid Service」扱いになりデータは学習に使われない
```

### 課金を $0 に抑える設定（2段構え）

**予算アラートだけでは課金を止められない**（通知のラグで数時間課金が続く）。
API クォータ制限を第1の防壁とし、予算アラートを保険として設定する。

#### 第1の防壁：API クォータ制限（確実・同期的に遮断）

```
Google Cloud Console
  → APIs & Services → Quotas & System Limits
  → Generative Language API

設定値（無料枠の上限値をそのまま設定）：
  - Requests per day: 1,500
  → 上限到達でリクエストがエラー返却され、課金ゼロのまま停止
```

#### 第2の防壁：予算アラート（念のための通知）

```
Cloud Billing → Budgets & Alerts → Create Budget

設定：
  - 予算額: $1
  - 閾値: 50% / 90% / 100%
  - 通知先: 管理者メールアドレス
  （予算に達してもサービスは自動停止しないが、異常を検知できる）
```

---

## 環境変数（`.env.local` に記載、コミット禁止）

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXTAUTH_SECRET=
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
ALLOWED_EMAIL_SUFFIX=.nutfes@gmail.com
```

---

## 参考リンク

- [Gemini API 無料枠](https://ai.google.dev/gemini-api/docs/pricing)
- [Supabase pgvector](https://supabase.com/docs/guides/ai/vector-columns)
- [Google Drive API Python Quickstart](https://developers.google.com/drive/api/quickstart/python)
- [HuggingFace Spaces](https://huggingface.co/spaces)
