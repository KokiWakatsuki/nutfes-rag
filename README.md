# 学祭 AI サポーター

学祭実行委員が蓄積してきた Google Drive の資料を AI が検索・回答するシステムです。

---

## 目次

1. [全体の流れ](#全体の流れ)
2. [Google Cloud のセットアップ](#1-google-cloud-のセットアップ)
3. [Supabase のセットアップ](#2-supabase-のセットアップ)
4. [ローカル環境のセットアップ](#3-ローカル環境のセットアップ)
5. [初回の Drive 同期（ローカル実行）](#4-初回の-drive-同期ローカル実行)
6. [Vercel へのデプロイ](#5-vercel-へのデプロイ)
7. [GitHub Actions の設定（毎日自動同期）](#6-github-actions-の設定毎日自動同期)
8. [運用方法](#7-運用方法)

---

## 全体の流れ

```
Google Drive（資料）
  ↓ サービスアカウントで自動取得
Gemini text-embedding-004（ベクトル化）
  ↓
Supabase pgvector（保存・検索）
  ↓
Gemini 2.0 Flash（回答生成）
  ↓
Web チャット UI（ログイン後すぐ使える）
```

---

## 1. Google Cloud のセットアップ

### 1-1. プロジェクト作成

1. [Google Cloud Console](https://console.cloud.google.com) を開く
2. 上部の「プロジェクトを選択」→「新しいプロジェクト」
3. プロジェクト名（例: `nutfes-rag`）を入力して作成

### 1-2. API の有効化

左メニュー → **APIs & Services → Library** で以下を有効化:

- `Google Drive API`
- `Generative Language API`（Gemini）

### 1-3. OAuth 2.0 クライアント（ログイン用）

1. **APIs & Services → OAuth consent screen**
   - User Type: **External**
   - アプリ名・メールを入力して保存
   - スコープは追加不要
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs に追加:
     ```
     http://localhost:3000/api/auth/callback/google
     https://あなたのVercelURL.vercel.app/api/auth/callback/google
     ```
3. 作成後に表示される **Client ID** と **Client Secret** をメモ

### 1-4. サービスアカウント（Drive 読み取り用）

1. **IAM & Admin → Service Accounts → Create Service Account**
   - 名前（例: `drive-reader`）を入力して作成
2. 作成後、右の「︙」→ **Manage keys → Add key → Create new key → JSON** → ダウンロード
3. ダウンロードした JSON ファイルをテキストエディタで開いておく（後で使用）
4. サービスアカウントのメールアドレス（`drive-reader@xxxx.iam.gserviceaccount.com`）をメモ

### 1-5. Google Drive フォルダをサービスアカウントと共有

各年度のフォルダを以下の手順で共有:

1. Google Drive で対象フォルダを右クリック → **共有**
2. サービスアカウントのメールアドレス（`drive-reader@xxxx.iam.gserviceaccount.com`）を入力
3. 権限: **閲覧者** で共有

### 1-6. Gemini API キーの取得

1. [Google AI Studio](https://aistudio.google.com) を開く（同じ Google アカウント）
2. 左上 **Get API key → Create API key**
3. 先ほど作成したプロジェクト（`nutfes-rag`）を選択して生成

> ⚠️ **データ保護について**
> 無料枠のデフォルト設定ではデータが学習に使われる場合があります。
> Google Cloud プロジェクトに請求情報を登録（有効化するだけ、実際の課金は発生しない）することで
> Paid Service 扱いになり、データは学習に使われなくなります。

---

## 2. Supabase のセットアップ

### 2-1. プロジェクト作成

1. [supabase.com](https://supabase.com) でアカウント作成（GitHub でログイン可）
2. **New Project** をクリック
   - プロジェクト名: `nutfes-rag`
   - Database Password: 任意のパスワード（メモしておく）
   - Region: **Northeast Asia (Tokyo)**
3. 数分待ってプロジェクトが起動するまで待つ

### 2-2. データベーススキーマの作成

1. 左サイドバー → **SQL Editor**
2. `supabase/schema.sql` の中身を全選択してコピー
3. エディタに貼り付けて **Run**（▶ ボタン）を押す
4. `Success` と表示されれば完了

### 2-3. 接続情報の取得

左サイドバー → **Project Settings → API** で以下をメモ:

- **Project URL** → `SUPABASE_URL`
- **service_role** キー（secret と書かれている方）→ `SUPABASE_SERVICE_KEY`

---

## 3. ローカル環境のセットアップ

### 3-1. リポジトリのクローンと依存インストール

```bash
git clone https://github.com/KokiWakatsuki/nutfes-rag.git
cd nutfes-rag
npm install
```

### 3-2. 環境変数の設定

```bash
cp .env.local.example .env.local
```

`.env.local` を開いて各値を埋める:

```env
# Google OAuth（ログイン用）
GOOGLE_CLIENT_ID=        ← 1-3 で取得した Client ID
GOOGLE_CLIENT_SECRET=    ← 1-3 で取得した Client Secret

# NextAuth シークレット（ランダム文字列）
# ターミナルで openssl rand -base64 32 を実行して貼り付け
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000

# 許可するメールアドレスのサフィックス
ALLOWED_EMAIL_SUFFIX=.nutfes@gmail.com

# Gemini API キー
GEMINI_API_KEY=          ← 1-6 で取得したキー

# Supabase
SUPABASE_URL=            ← 2-3 で取得した Project URL
SUPABASE_SERVICE_KEY=    ← 2-3 で取得した service_role キー

# Google サービスアカウント（Drive 同期用）
# 1-4 でダウンロードした JSON ファイルの中身をそのまま貼り付け
GOOGLE_SERVICE_ACCOUNT_KEY=

# 同期 API の認証トークン（GitHub Actions 用）
# ターミナルで openssl rand -base64 32 を実行して貼り付け
CRON_SECRET=
```

### 3-3. Drive の設定

`config/drives.json` を開いて、各回次のフォルダ ID を設定:

```json
[
  { "edition": 43, "driveId": "Google Drive フォルダの ID" },
  { "edition": 42, "driveId": "Google Drive フォルダの ID" }
]
```

**フォルダ ID の確認方法:**
Google Drive でフォルダを開いたときの URL の末尾部分です。
```
https://drive.google.com/drive/folders/【ここがフォルダID】
```

---

## 4. 初回の Drive 同期（ローカル実行）

> ⚠️ **重要**: 資料が大量にある場合、Vercel 上のボタンでは5分でタイムアウトします。
> **初回は必ずローカルで実行してください。**

### 実行コマンド

```bash
npm run sync
```

### 注意事項

**Gemini API の無料枠制限:**
- 1日あたり **1,500 リクエスト** まで
- ファイル数が多い場合、1日で全件処理できないことがあります
- 上限に達すると自動的に停止します
- **翌日に再実行すると続きから処理されます**（処理済みファイルはスキップ）

**処理の目安:**
- 1ファイルあたり平均 3〜5 チャンクとすると
- 1日あたり **300〜500 ファイル** 程度処理可能
- それ以上ある場合は複数日に分けて実行

**途中で止めた場合:**
Ctrl+C で止めても問題ありません。再実行すると続きから処理されます。

### 実行ログの例

```
=== 第43回 (15XPjdL1z4...) ===
ファイル一覧を取得中...
合計 312 件 / 未処理 312 件 / スキップ 0 件
[1/312] ✓ 総合計画書2023.pdf (8 チャンク)
[2/312] ✓ 企画書_ステージ.docx (3 チャンク)
...
```

---

## 5. Vercel へのデプロイ

### 5-1. Vercel プロジェクト作成

1. [vercel.com](https://vercel.com) で GitHub ログイン
2. **New Project** → `nutfes-rag` リポジトリを選択 → **Import**

### 5-2. 環境変数の設定

**Settings → Environment Variables** で以下を追加（`.env.local` と同じ値）:

| 変数名 | 値 |
|---|---|
| `GOOGLE_CLIENT_ID` | Google の Client ID |
| `GOOGLE_CLIENT_SECRET` | Google の Client Secret |
| `NEXTAUTH_SECRET` | ランダム文字列 |
| `NEXTAUTH_URL` | `https://あなたのURL.vercel.app` |
| `ALLOWED_EMAIL_SUFFIX` | `.nutfes@gmail.com` |
| `GEMINI_API_KEY` | Gemini の API キー |
| `SUPABASE_URL` | Supabase の Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase の service_role キー |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | サービスアカウント JSON の中身 |
| `CRON_SECRET` | ランダム文字列 |

### 5-3. デプロイ

**Deploy** を押す。完了後に発行される URL をメモ。

### 5-4. Google OAuth に URL を追加

Google Cloud Console → **APIs & Services → Credentials → OAuth Client ID** を編集:

**Authorized redirect URIs** に追加:
```
https://あなたのURL.vercel.app/api/auth/callback/google
```

---

## 6. GitHub Actions の設定（毎日自動同期）

新しいファイルを毎日自動でインデックスします。

### 6-1. Secrets の登録

GitHub リポジトリ → **Settings → Secrets and variables → Actions → New repository secret** で以下を登録:

| Secret 名 | 値 |
|---|---|
| `GEMINI_API_KEY` | Gemini の API キー |
| `SUPABASE_URL` | Supabase の Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase の service_role キー |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | サービスアカウント JSON の中身 |

### 6-2. 動作確認

**Actions タブ → Daily Drive Sync → Run workflow** で手動実行して確認。

毎日 JST 9:00 に自動実行されます。

---

## 7. 運用方法

### 新しい年度の Drive を追加する

1. `config/drives.json` に追加:
   ```json
   { "edition": 44, "driveId": "新しいフォルダのID" }
   ```
2. フォルダをサービスアカウントと共有（閲覧者権限）
3. `git push` → Vercel が自動デプロイ
4. ローカルで `npm run sync` を実行（初回のみ）

### 手動で同期したい場合

- **少量の追加ファイルのみ**: Web UI の「Drive を同期」ボタン
- **大量のファイル**: ローカルで `npm run sync`

### 同期済みデータを確認する

Supabase の **Table Editor → documents** でインデックス済みのファイル一覧を確認できます。
