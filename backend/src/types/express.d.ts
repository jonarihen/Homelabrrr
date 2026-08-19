import 'express-session';

// The session fields the app sets across auth/middleware. Declared here so
// every route sees them without a local cast.
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    isAdmin?: boolean;
    twoFactorEnrollmentOnly?: boolean;
    twoFactorUserId?: number;
    pendingUserId?: number;
    reauthenticatedAt?: number;
    lastSeenAt?: number;
    clientIp?: string;
    userAgent?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      // Set by the API-token middleware for Bearer-authenticated requests.
      apiToken?: {
        id: number;
        userId: number;
        scopes: string[];
        name?: string;
      };
    }
  }
}

export {};
