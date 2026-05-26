# 学祭 AI サポーター

学祭実行委員が蓄積してきた Google Drive の資料を AI が検索・回答するシステムです。

---

## 目次

1. [全体の流れ](#1-全体の流れ)
2. [Google Cloud のセットアップ](#2-google-cloud-のセットアップ)
3. [Supabase のセットアップ](#3-supabase-のセットアップ)
4. [ローカル環境のセットアップ](#4-ローカル環境のセットアップ)
5. [初回の Drive 同期](#5-初回の-drive-同期)
6. [Vercel へのデプロイ](#6-vercel-へのデプロイ)
7. [GitHub Actions の設定](#7-github-actions-の設定毎日自動同期)
8. [運用方法](#8-運用方法)
9. [コスト](#9-コスト)
10. [アカウントを変更する場合](#10-アカウントを変更する場合)

---

## 1. 全体の流れ

```
Google Drive（資料）
  ↓ サービスアカウントで自動取得
Gemini gemini-embedding-001（ベクトル化）
  ↓
Supabase pgvector（保存・検索）
  ↓
Gemini 2.0 Flash（回答生成）
  ↓
Web チャット UI（ログイン後すぐ使える）
```

### 対応ファイル形式

| 種別 | 処理方法 |
|------|---------|
| Google ドキュメント / スプレッドシート / スライド | Drive export API |
| テキスト PDF | pdf-parse で直接抽出 |
| スキャン PDF・画像（JPEG/PNG 等） | Gemini Flash OCR |
| Word / Excel / PowerPoint | Gemini Flash で読み取り |
| .txt / .csv / .html 等 | 直接ダウンロード |

---

## 2. Google Cloud のセットアップ

### 2-1. プロジェクト作成

1. [Google Cloud Console](https://console.cloud.google.com) を開く
2. 上部「プロジェクトを選択」→「新しいプロジェクト」
3. プロジェクト名（例: `nutfes-rag`）を入力して作成

### 2-2. 請求情報の登録（$300 無料クレジット取得）

> **初回インデックスを1時間以内に完了させるために必要です。**
> 新規アカウントなら $300 の無料クレジット（90日間有効）が付与されます。
> 課金を有効化することで、送信データが Google の学習に使われなくなります。

1. 左メニュー → **お支払い（Billing）**
2. 「請求先アカウントをリンク」→「請求先アカウントを作成」
3. 国・クレジットカード情報を入力して登録
4. プロジェクトに請求先アカウントをリンク

### 2-3. 予算アラートの設定（安全のため推奨）

> 予算超過を検知するための設定です（自動停止はしませんが通知が来ます）。

1. 左メニュー → **お支払い → 予算とアラート → 予算を作成**
2. 設定値:
   - 予算額: **$5**
   - 閾値: 50% / 90% / 100%
   - 通知先: 管理者のメールアドレス

### 2-4. API の有効化

左メニュー → **APIs & Services → ライブラリ** で以下を有効化:

- `Google Drive API`
- `Generative Language API`（Gemini）

### 2-5. OAuth 2.0 クライアント（ログイン用）

1. **APIs & Services → OAuth 同意画面**
   - ユーザータイプ: **External**
   - アプリ名・メールアドレスを入力して保存
2. **APIs & Services → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
   - アプリケーションの種類: **ウェブアプリケーション**
   - 承認済みのリダイレクト URI に追加:
     ```
     http://localhost:3000/api/auth/callback/google
     https://あなたのVercelURL.vercel.app/api/auth/callback/google
     ```
   （Vercel URL は後から追加でも可）
3. 作成後に表示される **クライアント ID** と **クライアント シークレット** をメモ

### 2-6. サービスアカウント（Drive 読み取り用）

1. **IAM と管理 → サービスアカウント → サービスアカウントを作成**
   - 名前: `drive-reader`（任意）
2. 作成後、サービスアカウントをクリック → **キー → キーを追加 → 新しいキーを作成 → JSON**
3. ダウンロードした JSON ファイルを安全な場所に保存
4. サービスアカウントのメールアドレス（`drive-reader@xxxx.iam.gserviceaccount.com`）をメモ

### 2-7. Google Drive フォルダをサービスアカウントと共有

**各回次のフォルダそれぞれで**以下を実施:

1. Google Drive でフォルダを右クリック → **共有**
2. サービスアカウントのメールアドレスを入力
3. 権限: **閲覧者** を選択して共有

**フォルダ ID の確認方法:**

```
https://drive.google.com/drive/folders/【ここがフォルダ ID】
```

このフォルダ ID を `config/drives.json` に設定します。

### 2-8. Gemini API キーの取得

1. [Google AI Studio](https://aistudio.google.com) を開く（同じ Google アカウントでログイン）
2. **API キーを取得 → API キーを作成**
3. 先ほど作成したプロジェクト（`nutfes-rag`）を選択して生成
4. 表示されたキーをメモ

---

## 3. Supabase のセットアップ

### 3-1. プロジェクト作成

1. [supabase.com](https://supabase.com) でアカウント作成（GitHub でログイン可）
2. **New Project** をクリック
   - プロジェクト名: `nutfes-rag`
   - Database Password: 任意のパスワード（メモしておく）
   - Region: **Northeast Asia (Tokyo)**
3. 数分待ってプロジェクトが起動するまで待つ

### 3-2. データベーススキーマの作成

1. 左サイドバー → **SQL Editor**
2. `supabase/schema.sql` の中身を全選択してコピー
3. エディタに貼り付けて **Run**（▶ ボタン）を押す
4. エラーなく完了すれば OK

### 3-3. 接続情報の取得

左サイドバー → **Project Settings → API** で以下をメモ:

| 項目 | 環境変数名 | 場所 |
|------|-----------|------|
| Project URL | `SUPABASE_URL` | 「URL」欄 |
| service_role キー | `SUPABASE_SERVICE_KEY` | 「Project API keys」の `service_role`（`anon` ではない方） |

---

## 4. ローカル環境のセットアップ

### 4-1. クローンと依存インストール

```bash
git clone https://github.com/KokiWakatsuki/nutfes-rag.git
cd nutfes-rag
npm install
```

### 4-2. 環境変数の設定

`.env.local` ファイルをプロジェクト直下に作成:

```env
# Google OAuth（ログイン用）── 2-5 で取得
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# NextAuth シークレット（ランダム文字列）
# ターミナルで次を実行して貼り付け: openssl rand -base64 32
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000

# 許可するメールアドレスのサフィックス
ALLOWED_EMAIL_SUFFIX=.nutfes@gmail.com

# Gemini API キー── 2-8 で取得
GEMINI_API_KEY=

# Supabase── 3-3 で取得
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Google サービスアカウント── 2-6 でダウンロードした JSON の中身を1行で貼り付け
# 例: GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"..."}
GOOGLE_SERVICE_ACCOUNT_KEY=

# 同期 API の認証トークン（GitHub Actions / 手動トリガー用）
# ターミナルで次を実行して貼り付け: openssl rand -base64 32
CRON_SECRET=
```

> **`GOOGLE_SERVICE_ACCOUNT_KEY` の貼り付け方**
> JSON ファイルをテキストエディタで開き、中身を全選択してコピー。
> .env.local では改行なし・1行で貼り付けてください。
> Vercel のダッシュボードでは複数行のまま貼り付けて構いません。

### 4-3. Drive の設定

`config/drives.json` を開いて各回次のフォルダ ID を設定:

```json
[
  { "edition": 43, "driveId": "フォルダ ID（2-7 で確認）" },
  { "edition": 42, "driveId": "フォルダ ID（2-7 で確認）" }
]
```

---

## 5. 初回の Drive 同期

> **重要**: 初回は必ずローカルで実行してください。
> Vercel 上のボタンは5分でタイムアウトするため、大量ファイルには対応できません。

### 実行コマンド

```bash
npm run sync
```

### 所要時間の目安

| 課金状態 | 対象ファイル数 | 所要時間 |
|---------|-------------|---------|
| **課金あり（推奨）** | 5,000件 | **1時間以内** |
| 課金なし（無料枠） | 5,000件 | 数日〜数週間 |

課金を有効にすることで API クォータ上限が大幅に上がり、一気に処理できます。

### 対象ファイル種別の絞り込み（任意）

環境変数 `SYNC_TYPES` でフィルタリングできます:

```bash
# 全ファイル（デフォルト）
npm run sync

# PDF を除外
SYNC_TYPES=no-pdf npm run sync

# ドキュメント・スライドのみ
SYNC_TYPES=docs-slides npm run sync

# ドキュメントのみ
SYNC_TYPES=docs npm run sync
```

### 実行ログの例

```
対象種別: 全種別（PDF 含む）(SYNC_TYPES=all)

=== 第43回 (15XPjdL1z4...) ===
ファイル一覧を取得中...
合計 2,648 件 / 未処理 2,648 件 / スキップ 0 件
  埋め込み次元数: 768
[1/2648] ✓ 43rd_綜合計画書.pdf (12 チャンク)
[2/2648] ✓ 43rd_シフト表.xlsx (3 チャンク)
...
```

### 途中で止まった場合

`Ctrl+C` で止めても問題ありません。再実行すると処理済みファイルはスキップされ、続きから再開されます。

---

## 6. Vercel へのデプロイ

### 6-1. プロジェクト作成

1. [vercel.com](https://vercel.com) で GitHub ログイン
2. **New Project** → `nutfes-rag` リポジトリを選択 → **Import**

### 6-2. 環境変数の設定

**Settings → Environment Variables** で以下を追加:

| 変数名 | 値 | 備考 |
|-------|----|------|
| `GOOGLE_CLIENT_ID` | Google の Client ID | 2-5 |
| `GOOGLE_CLIENT_SECRET` | Google の Client Secret | 2-5 |
| `NEXTAUTH_SECRET` | ランダム文字列 | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | `https://あなたのURL.vercel.app` | デプロイ後に確定 |
| `ALLOWED_EMAIL_SUFFIX` | `.nutfes@gmail.com` | |
| `GEMINI_API_KEY` | Gemini の API キー | 2-8 |
| `SUPABASE_URL` | Supabase の Project URL | 3-3 |
| `SUPABASE_SERVICE_KEY` | Supabase の service_role キー | 3-3 |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | サービスアカウント JSON の中身 | 2-6（複数行 OK）|
| `CRON_SECRET` | ランダム文字列 | `openssl rand -base64 32` |

### 6-3. デプロイ

**Deploy** を押す。完了後に発行される URL（例: `nutfes-rag.vercel.app`）をメモ。

### 6-4. Google OAuth に Vercel URL を追加

Google Cloud Console → **APIs & Services → 認証情報 → OAuth クライアント ID** を編集:

**承認済みのリダイレクト URI** に追加:
```
https://あなたのURL.vercel.app/api/auth/callback/google
```

### 6-5. NEXTAUTH_URL の更新

Vercel の Environment Variables で `NEXTAUTH_URL` を Vercel URL に更新:
```
https://あなたのURL.vercel.app
```

更新後、**Deployments → Redeploy** で再デプロイ。

---

## 7. GitHub Actions の設定（毎日自動同期）

毎日 JST 9:00 に新規・更新ファイルを自動インデックスします。

### 7-1. Secrets の登録

GitHub リポジトリ → **Settings → Secrets and variables → Actions → New repository secret** で以下を登録:

| Secret 名 | 値 |
|----------|----|
| `GEMINI_API_KEY` | Gemini の API キー |
| `SUPABASE_URL` | Supabase の Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase の service_role キー |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | サービスアカウント JSON の中身 |

### 7-2. 動作確認

**Actions タブ → Daily Drive Sync → Run workflow** で手動実行して確認。

---

## 8. 運用方法

### 新しい回次の Drive を追加する

1. サービスアカウントと対象フォルダを共有（閲覧者権限）
2. `config/drives.json` に追加:
   ```json
   { "edition": 44, "driveId": "新しいフォルダの ID" }
   ```
3. `git push` → Vercel が自動デプロイ
4. ローカルで `npm run sync` を実行（初回のみ大量処理）

### 手動で同期したい場合

- **Web UI のボタン**: 少量の追加ファイル向け（5分でタイムアウト）
- **ローカルで `npm run sync`**: 大量ファイル向け（タイムアウトなし）

### インデックス済みデータの確認

Supabase の **Table Editor → documents** でファイル一覧を確認できます。

### 推定にかかる時間を確認したい場合

```bash
npm run estimate
```

---

## 9. コスト

| 時期 | 内容 | 目安 |
|-----|------|------|
| 初回セットアップ | 全ファイルのインデックス | $3〜5 |
| 毎月 | 差分同期 + チャット利用 | $0.50〜1.00 |
| **年間** | | **$9〜17** |

新規アカウントの $300 無料クレジット（90日間有効）で初回インデックスは実質無料。
90日後以降は月 $0.50〜1.00（75〜150円）の実費が発生します。

---

## 10. アカウントを変更する場合

Google アカウントを変更したとき（例: 新しい Cloud アカウントで $300 クレジットを使う場合）に更新が必要なものです。

### 更新が必要なもの

| 項目 | 更新箇所 |
|-----|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `.env.local` / Vercel 環境変数 |
| `GEMINI_API_KEY` | `.env.local` / Vercel 環境変数 / GitHub Secrets |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `.env.local` / Vercel 環境変数 / GitHub Secrets |
| Google Drive フォルダの共有設定 | 新サービスアカウントのメールで再共有 |
| Google OAuth のリダイレクト URI | 新プロジェクトの認証情報に Vercel URL を追加 |

### 更新不要なもの

- Supabase（`SUPABASE_URL` / `SUPABASE_SERVICE_KEY`）: 既存のプロジェクトをそのまま使用可
- `NEXTAUTH_SECRET` / `CRON_SECRET`: 変更不要（変えると全ユーザーが再ログイン必要）
- `config/drives.json`: フォルダ ID は変わらないため変更不要
- インデックス済みデータ: Supabase はそのまま引き継がれる

### 手順

1. 新 Google Cloud プロジェクトを作成（[2. Google Cloud のセットアップ](#2-google-cloud-のセットアップ) を参照）
2. `.env.local` の該当箇所を更新
3. Vercel と GitHub Secrets の該当箇所を更新
4. 新サービスアカウントのメールで Drive フォルダを再共有
5. （Supabase のデータは引き継ぐため、初回 sync は不要）
