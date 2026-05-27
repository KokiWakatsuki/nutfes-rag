import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateEmbedding, generateAnswer } from "@/lib/gemini";
import {
  searchDocuments,
  createChatSession,
  getChatSession,
  touchChatSession,
  saveChatMessage,
} from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userEmail = session.user.email;

  const { question, editions, sessionId } = await req.json();
  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const filterEditions: number[] | null =
    Array.isArray(editions) && editions.length > 0 ? editions : null;

  // セッション管理・会話履歴取得
  let currentSessionId: string = sessionId ?? null;
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];

  if (!currentSessionId) {
    const title = question.length > 40 ? question.slice(0, 40) + "…" : question;
    const newSession = await createChatSession(userEmail, title, filterEditions);
    currentSessionId = newSession.id;
  } else {
    const [sessionData] = await Promise.all([
      getChatSession(currentSessionId, userEmail),
      touchChatSession(currentSessionId),
    ]);
    if (sessionData) {
      history = sessionData.messages.map((m) => ({ role: m.role, content: m.content }));
    }
  }

  await saveChatMessage(currentSessionId, "user", question, []);

  const embedding = await generateEmbedding(question);
  const docs = await searchDocuments(embedding, filterEditions, 8);

  // ファイルIDでソース重複排除
  const seenFileIds = new Set<string>();
  const sources: Array<{ fileName: string; edition: number }> = [];
  for (const d of docs) {
    if (!seenFileIds.has(d.file_id)) {
      seenFileIds.add(d.file_id);
      sources.push({ fileName: d.file_name, edition: d.edition });
    }
  }

  if (docs.length === 0) {
    const answer = "関連する資料が見つかりませんでした。";
    await saveChatMessage(currentSessionId, "assistant", answer, []);
    return NextResponse.json({ answer, sources: [], sessionId: currentSessionId });
  }

  const answer = await generateAnswer(question, docs, history);
  await saveChatMessage(currentSessionId, "assistant", answer, sources);

  return NextResponse.json({ answer, sources, sessionId: currentSessionId });
}
