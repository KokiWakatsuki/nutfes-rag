import drives from "../../config/drives.json";
import { listAllFiles, fetchFileContent, chunkText } from "./drive";
import { generateEmbedding } from "./gemini";
import { upsertDocument, getIndexedFileIds } from "./supabase";

export interface SyncResult {
  processed: number;
  skipped: number;
  errors: number;
}

// Gemini Embedding API: 無料枠 100 RPM / 1500 RPD
// 700ms 間隔 ≒ 85 RPM で安全に収まる
const EMBED_INTERVAL_MS = 700;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncAllDrives(): Promise<SyncResult> {
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  const syncTypes = process.env.SYNC_TYPES ?? "all";
  const typeLabels: Record<string, string> = {
    all: "全種別（PDF 含む）",
    "no-pdf": "PDF を除外",
    "docs-slides": "ドキュメント・スライドのみ",
    docs: "ドキュメントのみ",
  };
  console.log(`対象種別: ${typeLabels[syncTypes] ?? syncTypes} (SYNC_TYPES=${syncTypes})`);

  for (const { edition, driveId } of drives) {
    console.log(`\n=== 第${edition}回 (${driveId}) ===`);
    const result = await syncDrive(driveId, edition);
    processed += result.processed;
    skipped += result.skipped;
    errors += result.errors;
  }

  return { processed, skipped, errors };
}

async function syncDrive(
  driveId: string,
  edition: number
): Promise<SyncResult> {
  console.log("ファイル一覧を取得中...");
  const files = await listAllFiles(driveId);
  const indexedIds = new Set(await getIndexedFileIds(driveId));

  const newFiles = files.filter((f) => !indexedIds.has(f.id));
  console.log(
    `合計 ${files.length} 件 / 未処理 ${newFiles.length} 件 / スキップ ${files.length - newFiles.length} 件`
  );

  let processed = 0;
  let errors = 0;
  let embedCallCount = 0;

  for (let i = 0; i < newFiles.length; i++) {
    const file = newFiles[i];
    const progress = `[${i + 1}/${newFiles.length}]`;

    try {
      const content = await fetchFileContent(file.id, file.mimeType);
      if (!content.trim()) {
        console.log(`${progress} スキップ（空）: ${file.name}`);
        continue;
      }

      const chunks = chunkText(content);
      for (const chunk of chunks) {
        await sleep(EMBED_INTERVAL_MS);
        embedCallCount++;

        // 1500 RPD 上限に近づいたら警告
        if (embedCallCount === 1400) {
          console.warn(
            "⚠️  本日の Gemini API 呼び出しが 1400 回に達しました。上限（1500回/日）まで残り少ないです。"
          );
        }

        const embedding = await generateEmbedding(chunk);
        await upsertDocument({
          file_id: file.id,
          file_name: file.name,
          content: chunk,
          edition,
          drive_id: driveId,
          embedding,
        });
      }

      processed++;
      console.log(`${progress} ✓ ${file.name} (${chunks.length} チャンク)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      // 日次クォータ超過は致命的エラー → 残りを諦める
      if (msg.includes("429") || msg.toLowerCase().includes("quota")) {
        console.error(
          `\n❌ Gemini API の1日の上限（1500回）に達しました。明日以降に再実行してください。`
        );
        console.error(`   中断時点: ${i + 1}/${newFiles.length} 件処理済み`);
        return { processed, skipped: files.length - newFiles.length, errors };
      }

      console.error(`${progress} ✗ ${file.name}: ${msg}`);
      errors++;
    }
  }

  return {
    processed,
    skipped: files.length - newFiles.length,
    errors,
  };
}
