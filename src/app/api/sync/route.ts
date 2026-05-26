import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncAllDrives } from "@/lib/sync";

// Vercel の最大実行時間（秒）
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // GitHub Actions の cron からのリクエストは Authorization ヘッダーで認証
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  const isCron =
    cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    // ブラウザからは NextAuth セッションで認証
    const session = await auth();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await syncAllDrives();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("Sync failed:", err);
    return NextResponse.json(
      { error: "Sync failed", details: String(err) },
      { status: 500 }
    );
  }
}
