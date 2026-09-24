import { Request, Response } from 'express';

import { AuthService } from "@/services/authService";

export async function requireAuth(
    req: Request,
    res: Response,
    authService: AuthService
  ): Promise<{ userId: string } | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required', code: 'AUTH_TOKEN_MISSING' });
      return null;
    }
    const token = authHeader.substring(7);
    const result = await authService.verifyAuthToken(token);
    if (!result.valid || !result.userId) {
      res.status(401).json({ error: result.error || 'Invalid token', code: 'AUTH_TOKEN_INVALID' });
      return null;
    }
    return { userId: result.userId };
  }