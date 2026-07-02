import { v4 as uuidv4 } from 'uuid';
import { Request, Response, NextFunction } from 'express';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const id = req.get('x-correlation-id') || uuidv4();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}
