import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type pg from 'pg';

export type Mail = { to: string; subject: string; text: string };

export type AuthConfig = {
  // Pool whose search_path starts with "core", so Better Auth's tables live next to our other core tables.
  pool: pg.Pool;
  secret: string;
  baseURL: string;
  sendMail: (mail: Mail) => Promise<void>;
  google?: { clientId: string; clientSecret: string };
};

export type AuthMethod = 'password' | 'google';

// The method is stored on the session, like Twenty's authProvider claim, so each workspace can accept or refuse it.
const methodOf = (context: { path?: string; params?: Record<string, string> } | null | undefined): AuthMethod =>
  context?.path?.startsWith('/callback') && context.params?.id === 'google' ? 'google' : 'password';

export const authOptions = (config: AuthConfig): BetterAuthOptions => ({
  database: config.pool,
  secret: config.secret,
  baseURL: config.baseURL,
  emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 10 },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) =>
      config.sendMail({ to: user.email, subject: 'Verify your email', text: `Confirm your email address: ${url}` }),
  },
  socialProviders: config.google ? { google: config.google } : {},
  session: { additionalFields: { authMethod: { type: 'string', required: false, input: false } } },
  databaseHooks: {
    session: {
      create: {
        before: async (session, context) => ({ data: { ...session, authMethod: methodOf(context as never) } }),
      },
    },
  },
});

export const createAuth = (config: AuthConfig) => betterAuth(authOptions(config));
export type Auth = ReturnType<typeof createAuth>;
