/**
 * Drive のフォルダ構成をツリー表示するスクリプト
 * 実行: tsx --env-file=.env.local scripts/drive-tree.ts
 */
import { google } from "googleapis";
import drives from "../config/drives.json";

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

async function buildTree(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  indent = "",
  isLast = true
): Promise<void> {
  let pageToken: string | undefined;
  const children: Array<{ id: string; name: string; isFolder: boolean }> = [];

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      orderBy: "name",
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name) continue;
      children.push({
        id: f.id,
        name: f.name,
        isFolder: f.mimeType === "application/vnd.google-apps.folder",
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // フォルダを先、ファイルを後に並べる
  children.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, "ja");
  });

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const last = i === children.length - 1;
    const branch = last ? "└── " : "├── ";
    const icon = child.isFolder ? "📁" : "📄";
    console.log(`${indent}${branch}${icon} ${child.name}`);

    if (child.isFolder) {
      const nextIndent = indent + (last ? "    " : "│   ");
      await buildTree(drive, child.id, nextIndent, last);
    }
  }
}

async function main() {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  for (const { edition, driveId } of drives) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📦 第${edition}回 (driveId: ${driveId})`);
    console.log("=".repeat(60));

    try {
      // Shared Drive かどうか確認
      try {
        const driveInfo = await drive.drives.get({ driveId });
        console.log(`🗂  Shared Drive: ${driveInfo.data.name}`);
      } catch {
        console.log(`🗂  サブフォルダ指定`);
      }

      await buildTree(drive, driveId);
    } catch (err) {
      console.error(`  ❌ アクセスエラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
