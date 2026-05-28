export { auth as middleware } from "@/auth";

export const config = {
  matcher: ["/chat/:path*", "/api/chat/:path*", "/api/sync/:path*", "/api/sessions/:path*"],
};
