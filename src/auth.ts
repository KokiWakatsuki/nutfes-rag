import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_SUFFIX = process.env.ALLOWED_EMAIL_SUFFIX ?? ".nutfes@gmail.com";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      return profile?.email?.endsWith(ALLOWED_SUFFIX) ?? false;
    },
    session({ session, token }) {
      return session;
    },
    jwt({ token, profile }) {
      return token;
    },
  },
  pages: {
    signIn: "/",
    error: "/",
  },
});
