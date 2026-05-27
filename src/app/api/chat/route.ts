import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateEmbedding, streamGenerateAnswer } from "@/lib/gemini";
import {
  searchDocuments,
  createChatSession,
  getChatSession,
  touchChatSession,
  saveChatMessage,
  checkRateLimit,
} from "@/lib/supabase";

export const maxDuration = 300;

// セッション管理・会話履歴取得（embedding 生成と並列実行するための関数）
async function setupSession(
  userEmail: string,
  sessionId: string | null,
  question: string,
  filterEditions: number[] | null
): Promise<{ sessionId: string; history: Array<{ role: "user" | "assistant"; content: string }> }> {
  if (!sessionId) {
    const title = question.length > 40 ? question.slice(0, 40) + "…" : question;
    const newSession = await createChatSession(userEmail, title, filterEditions);
    return { sessionId: newSession.id, history: [] };
  }
  const [sessionData] = await Promise.all([
    getChatSession(sessionId, userEmail),
    touchChatSession(sessionId),
  ]);
  const history = sessionData?.messages.map((m) => ({ role: m.role, content: m.content })) ?? [];
  return { sessionId, history };
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userEmail = session.user.email;

  if (!(await checkRateLimit(userEmail))) {
    return NextResponse.json({ error: "Too many requests. 1分後に再度お試しください。" }, { status: 429 });
  }

  const { question, editions, sessionId } = await req.json();
  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const filterEditions: number[] | null =
    Array.isArray(editions) && editions.length > 0 ? editions : null;

  // セッション管理と埋め込み生成を並列実行
  const [{ sessionId: currentSessionId, history }, embedding] = await Promise.all([
    setupSession(userEmail, sessionId ?? null, question, filterEditions),
    generateEmbedding(question),
  ]);

  // ユーザーメッセージ保存と文書検索を並列実行
  const [, docs] = await Promise.all([
    saveChatMessage(currentSessionId, "user", question, []),
    searchDocuments(embedding, filterEditions, 8, question),
  ]);

  // ファイルIDでソース重複排除
  const seenFileIds = new Set<string>();
  const sources: Array<{ fileName: string; edition: number }> = [];
  for (const d of docs) {
    if (!seenFileIds.has(d.file_id)) {
      seenFileIds.add(d.file_id);
      sources.push({ fileName: d.file_name, edition: d.edition });
    }
  }

  const sid = currentSessionId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      send({ type: "meta", sessionId: sid, sources });

      let fullText = "";

      if (docs.length === 0) {
        fullText = "関連する資料が見つかりませんでした。";
        send({ type: "text", text: fullText });
      } else {
        try {
          for await (const chunk of streamGenerateAnswer(question, docs, history)) {
            fullText += chunk;
            send({ type: "text", text: chunk });
          }
        } catch (err) {
          send({ type: "error", message: String(err) });
        }
      }

      try {
        await saveChatMessage(sid, "assistant", fullText || "エラーが発生しました。", sources);
      } catch (saveErr) {
        console.error("Failed to save assistant message:", saveErr);
      }

      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
