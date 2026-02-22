import { type NextAuthOptions } from "next-auth";
import TwitchProvider from "next-auth/providers/twitch";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    TwitchProvider({
      clientId: process.env.TWITCH_CLIENT_ID!,
      clientSecret: process.env.TWITCH_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "database" },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!account || account.provider !== "twitch" || !profile) return false;

      const twitchId = profile.sub as string;
      const twitchProfile = profile as {
        preferred_username?: string;
        picture?: string;
        email?: string;
        sub: string;
      };

      // Upsert user
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.id, twitchId))
        .get();

      if (existing) {
        await db
          .update(users)
          .set({
            displayName:
              twitchProfile.preferred_username ?? existing.displayName,
            profileImage: twitchProfile.picture ?? existing.profileImage,
            updatedAt: new Date(),
          })
          .where(eq(users.id, twitchId));
      } else {
        await db.insert(users).values({
          id: twitchId,
          username: twitchProfile.preferred_username?.toLowerCase() ?? twitchId,
          displayName: twitchProfile.preferred_username ?? "Streamer",
          profileImage: twitchProfile.picture,
          email: twitchProfile.email,
        });
      }

      // Store user id on the next-auth user object
      user.id = twitchId;
      return true;
    },

    async session({ session, token, user }) {
      if (session.user && user?.id) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: {
    // Minimal custom adapter talking directly to our SQLite db
    async createUser(user: unknown) {
      return user as never;
    },
    async getUser(id: string) {
      const row = await db.select().from(users).where(eq(users.id, id)).get();
      if (!row) return null;
      return {
        id: row.id,
        name: row.displayName,
        email: row.email ?? "",
        image: row.profileImage,
        emailVerified: null,
      } as never;
    },
    async getUserByEmail(_email: string) {
      return null;
    },
    async getUserByAccount({ providerAccountId }: { providerAccountId: string }) {
      const row = await db
        .select()
        .from(users)
        .where(eq(users.id, providerAccountId))
        .get();
      if (!row) return null;
      return {
        id: row.id,
        name: row.displayName,
        email: row.email ?? "",
        image: row.profileImage,
        emailVerified: null,
      } as never;
    },
    async updateUser(user: unknown) {
      return user as never;
    },
    async linkAccount() {},
    async createSession(session: { userId: string; sessionToken: string; expires: Date }) {
      await db.insert(sessions).values({
        id: crypto.randomUUID(),
        userId: session.userId,
        sessionToken: session.sessionToken,
        expires: session.expires,
      });
      return session as never;
    },
    async getSessionAndUser(sessionToken: string) {
      const row = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.sessionToken, sessionToken))
        .get();
      if (!row) return null;
      return {
        session: {
          userId: row.session.userId,
          sessionToken: row.session.sessionToken,
          expires: row.session.expires,
        },
        user: {
          id: row.user.id,
          name: row.user.displayName,
          email: row.user.email ?? "",
          image: row.user.profileImage,
          emailVerified: null,
        },
      } as never;
    },
    async updateSession(session: { sessionToken: string; expires?: Date }) {
      if (session.expires) {
        await db
          .update(sessions)
          .set({ expires: session.expires })
          .where(eq(sessions.sessionToken, session.sessionToken));
      }
      return session as never;
    },
    async deleteSession(sessionToken: string) {
      await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
    },
    async createVerificationToken(token: unknown) {
      return token as never;
    },
    async useVerificationToken() {
      return null;
    },
  } as never,
};

// authOptions is the only export needed — handlers are in app/api/auth/[...nextauth]/route.ts
