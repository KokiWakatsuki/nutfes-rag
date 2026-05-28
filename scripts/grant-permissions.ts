/**
 * サービスアカウントに全ファイルの閲覧権限を一括付与するスクリプト
 *
 * ローカル実行（ブラウザ認証）:
 *   tsx --env-file=.env.local scripts/grant-permissions.ts
 *
 * GitHub Actions（リフレッシュトークン使用）:
 *   環境変数 GOOGLE_REFRESH_TOKEN を設定して実行
 *   → scripts/get-refresh-token.ts で取得したトークンを GitHub Secrets に登録
 *
 * ローカル実行の事前準備:
 *   Google Cloud Console > APIs & Services > 認証情報 > OAuth 2.0 クライアント ID
 *   → 「承認済みのリダイレクト URI」に http://localhost:8888/callback を追加
 *   → OAuth 同意画面 > テストユーザーにあなたの Google アカウントを追加
 */
import { google } from "googleapis";
import * as http from "http";
import * as url from "url";
import drives from "../config/drives.json";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = "http://localhost:8888/callback";
const SERVICE_ACCOUNT_EMAIL = "nutfes-rag@nutfes-rag-497501.iam.gserviceaccount.com";
const SCOPES = ["https://www.googleapis.com/auth/drive"];

async function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  // GitHub Actions モード: リフレッシュトークンが環境変数にある場合はブラウザ不要
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (refreshToken) {
    console.log("リフレッシュトークンで認証します...");
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  }

  // ローカルモード: ブラウザで OAuth 認証
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n以下のURLをブラウザで開いて認証してください:\n");
  console.log(authUrl);
  console.log("\n認証後、自動的に続行します...\n");

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
    server.listen(8888, () => {
      console.log("localhost:8888 で待機中...");
    });
    server.on("error", reject);
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

const CONCURRENCY = 20;
const FOLDER_CONCURRENCY = 20;

async function listAllFileIds(
  drive: ReturnType<typeof google.drive>,
  folderId: string
): Promise<string[]> {
  const fileIds: string[] = [];
  const seenIds = new Set<string>();
  // BFS: 現在の深さのフォルダを並列処理し、次の深さへ進む
  let currentLevel: string[] = [folderId];
  let folderCount = 0;

  while (currentLevel.length > 0) {
    const nextLevel: string[] = [];

    // 同じ深さのフォルダを FOLDER_CONCURRENCY 件ずつ並列処理
    for (let i = 0; i < currentLevel.length; i += FOLDER_CONCURRENCY) {
      const batch = currentLevel.slice(i, i + FOLDER_CONCURRENCY);

      const subFolderGroups = await Promise.all(
        batch.map(async (parentId): Promise<string[]> => {
          const subFolders: string[] = [];
          let pageToken: string | undefined;

          do {
            const res = await drive.files.list({
              q: `'${parentId}' in parents and trashed = false`,
              includeItemsFromAllDrives: true,
              supportsAllDrives: true,
              fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
              pageSize: 1000,
              pageToken,
            });

            for (const f of res.data.files ?? []) {
              if (!f.id) continue;
              if (f.mimeType === "application/vnd.google-apps.folder") {
                subFolders.push(f.id);
              } else if (f.mimeType === "application/vnd.google-apps.shortcut") {
                // ショートカットはリンク先の実体ファイルに権限付与する
                const targetId = (f as { shortcutDetails?: { targetId?: string } }).shortcutDetails?.targetId;
                if (targetId && !seenIds.has(targetId)) {
                  seenIds.add(targetId);
                  fileIds.push(targetId);
                }
              } else if (!seenIds.has(f.id)) {
                seenIds.add(f.id);
                fileIds.push(f.id);
              }
            }
            pageToken = res.data.nextPageToken ?? undefined;
          } while (pageToken);

          return subFolders;
        })
      );

      folderCount += batch.length;
      for (const subFolders of subFolderGroups) nextLevel.push(...subFolders);
      process.stdout.write(`  フォルダ探索中: ${folderCount} フォルダ目, ファイル ${fileIds.length} 件\n`);
    }

    currentLevel = nextLevel;
  }

  return fileIds;
}

async function grantPermissions(
  drive: ReturnType<typeof google.drive>,
  fileIds: string[]
): Promise<{ granted: number; skipped: number; errors: number }> {
  let granted = 0;
  let skipped = 0;
  let errors = 0;
  let idx = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= fileIds.length) break;
      const fileId = fileIds[i];

      try {
        await drive.permissions.create({
          fileId,
          supportsAllDrives: true,
          requestBody: { type: "user", role: "reader", emailAddress: SERVICE_ACCOUNT_EMAIL },
          sendNotificationEmail: false,
        });
        granted++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("already has") ||
          msg.includes("403") ||
          msg.includes("cannotShareTeamDriveTopFolderWithAnyoneOrDomains") ||
          msg.includes("File not found") ||
          msg.includes("共有の権限がありません") ||
          msg.includes("sharingNotSupported") ||
          msg.includes("404")
        ) {
          skipped++;
        } else {
          errors++;
          console.error(`  ✗ エラー (${fileId}): ${msg}`);
        }
      }

      done++;
      if (done % 200 === 0) {
        console.log(`  ${done}/${fileIds.length} 件完了 (付与: ${granted}, スキップ: ${skipped}, エラー: ${errors})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { granted, skipped, errors };
}

async function main() {
  console.log("=== サービスアカウント権限一括付与スクリプト ===");
  console.log(`対象: ${SERVICE_ACCOUNT_EMAIL}`);
  console.log(`並列数: 権限付与 ${CONCURRENCY} / フォルダ探索 ${FOLDER_CONCURRENCY}`);
  console.log(`ドライブ数: ${drives.length}`);

  const auth = await getOAuthClient();
  const drive = google.drive({ version: "v3", auth });

  let totalGranted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const { edition, driveId } of drives) {
    console.log(`\n--- 第${edition}回 (${driveId}) ---`);
    console.log("ファイル一覧を取得中...");

    const fileIds = await listAllFileIds(drive, driveId);
    console.log(`${fileIds.length} 件のファイルに権限を付与します（並列${CONCURRENCY}）`);

    const { granted, skipped, errors } = await grantPermissions(drive, fileIds);
    totalGranted += granted;
    totalSkipped += skipped;
    totalErrors += errors;
  }

  console.log("\n=== 完了 ===");
  console.log(`付与: ${totalGranted} 件`);
  console.log(`スキップ（既付与）: ${totalSkipped} 件`);
  console.log(`エラー: ${totalErrors} 件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
