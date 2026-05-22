import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import ChatClient from "./ChatClient";
import drives from "../../../config/drives.json";

export default async function ChatPage() {
  const session = await auth();
  if (!session) redirect("/");

  const editions = drives.map((d) => d.edition).sort((a, b) => b - a);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800">
          学祭 AI サポーター
        </h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{session.user?.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="text-sm text-gray-600 hover:text-gray-900 underline"
            >
              ログアウト
            </button>
          </form>
        </div>
      </header>

      <ChatClient editions={editions} />
    </div>
  );
}
