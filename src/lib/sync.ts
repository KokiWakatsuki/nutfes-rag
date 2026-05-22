import drives from "../../config/drives.json";
import { listAllFiles, fetchFileContent, chunkText } from "./drive";
import { generateEmbeddingBatch } from "./gemini";
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

      // ファイル単位でバッチ処理（複数チャンクを1回のAPI呼び出しで処理）
      await sleep(EMBED_INTERVAL_MS);
      embedCallCount++;

      if (embedCallCount === 1400) {
        console.warn(
          "⚠️  本日の Gemini API 呼び出しが 1400 回に達しました。上限まで残り少ないです。"
        );
      }

      const embeddings = await generateEmbeddingBatch(chunks);

      // 最初の1件だけ次元数をログ出力（モデル変更時の確認用）
      if (i === 0) {
        console.log(`  埋め込み次元数: ${embeddings[0]?.length ?? "不明"}`);
      }

      for (let j = 0; j < chunks.length; j++) {
        await upsertDocument({
          file_id: file.id,
          file_name: file.name,
          content: chunks[j],
          edition,
          drive_id: driveId,
          embedding: embeddings[j],
        });
      }

      processed++;
      console.log(`${progress} ✓ ${file.name} (${chunks.length} チャンク)`);
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? err.message
        : (err as { message?: string })?.message ?? String(err);

      // 日次クォータ超過は致命的エラー → 残りを諦める
      if (msg.includes("429") || msg.toLowerCase().includes("quota")) {
        console.error(
          `\n❌ Gemini API の1日の上限に達しました。明日以降に再実行してください。`
        );
        console.error(`   中断時点: ${i + 1}/${newFiles.length} 件処理済み`);
        return { processed, skipped: files.length - newFiles.length, errors };
      }

      const detail = (err as { details?: string; code?: string; hint?: string })?.details
        ?? (err as { code?: string })?.code
        ?? JSON.stringify(err);
      console.error(`${progress} ✗ ${file.name}: ${msg || detail}`);
      errors++;
    }
  }

  return {
    processed,
    skipped: files.length - newFiles.length,
    errors,
  };
}
