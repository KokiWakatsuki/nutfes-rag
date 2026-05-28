/**
 * GitHub Actions 用のリフレッシュトークンを取得するスクリプト（初回のみローカルで実行）
 *
 * 実行:
 *   tsx --env-file=.env.local scripts/get-refresh-token.ts
 *
 * 取得したトークンを GitHub Secrets の GOOGLE_REFRESH_TOKEN に登録してください。
 *
 * 事前準備:
 *   Google Cloud Console > APIs & Services > 認証情報 > OAuth 2.0 クライアント ID
 *   → 「承認済みのリダイレクト URI」に http://localhost:8888/callback を追加
 *   → OAuth 同意画面 > テストユーザーにあなたの Google アカウントを追加
 */
import { google } from "googleapis";
import * as http from "http";
import * as url from "url";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = "http://localhost:8888/callback";
const SCOPES = ["https://www.googleapis.com/auth/drive"];

async function main() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n以下のURLをブラウザで開いて認証してください:\n");
  console.log(authUrl);
  console.log("\nlocalhost:8888 で待機中...");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url ?? "", true);
      if (parsed.pathname === "/callback" && parsed.query.code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>認証成功！このタブを閉じてターミナルに戻ってください。</h2>");
        server.close();
        resolve(parsed.query.code as string);
      } else if (parsed.query.error) {
        res.writeHead(400);
        res.end("認証エラー");
        server.close();
        reject(new Error(`OAuth error: ${parsed.query.error}`));
      }
    });
    server.listen(8888);
    server.on("error", reject);
  });

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error("\n❌ リフレッシュトークンが取得できませんでした。");
    console.error("以前に同じアカウントで認証したトークンが残っている可能性があります。");
    console.error("https://myaccount.google.com/permissions でアプリのアクセスを取り消してから再実行してください。");
    process.exit(1);
  }

  console.log("\n========================================");
  console.log("リフレッシュトークン（GitHub Secrets に登録）:");
  console.log("========================================");
  console.log(tokens.refresh_token);
  console.log("========================================\n");
  console.log("GitHub リポジトリ → Settings → Secrets and variables → Actions → New repository secret");
  console.log("  Name:  GOOGLE_REFRESH_TOKEN");
  console.log("  Value: 上記のトークン\n");
  console.log("⚠️  OAuth 同意画面が「テスト」モードの場合、このトークンは 7日間で失効します。");
  console.log("   「本番環境」に変更するとトークンの有効期限がなくなります（6ヶ月間未使用で失効）。");
  console.log("   OAuth 同意画面 → 「アプリを公開」→「確認」で変更できます。");
}

main().catch(console.error);
