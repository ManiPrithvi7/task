# How to Generate Auth Token for Postman

## The Problem

The session token from `/api/auth/session` is **encrypted (JWE)**, not a JWT. You **cannot use it directly** as `auth_token`.

The `auth_token` must be a **JWT signed with AUTH_SECRET** that contains your user ID.

## Solution: Create Next.js API Route (Recommended)

Create this file in your Next.js app:

**File:** `app/api/auth/token/route.ts`

```typescript
import { getServerSession } from 'next-auth';
import jwt from 'jsonwebtoken';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';

export async function GET() {
  const session = await getServerSession(authOptions);
  
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Generate JWT with user ID
  const token = jwt.sign(
    {
      sub: session.user.id,
      userId: session.user.id,
      email: session.user.email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
    },
    process.env.AUTH_SECRET!,
    { algorithm: 'HS256' }
  );

  return Response.json({ auth_token: token });
}
```

**Then in Postman:**
1. Call `GET http://localhost:3000/api/auth/token` (with your session cookie)
2. Copy the `auth_token` from response
3. Set it in Postman environment variable `auth_token`

## Alternative: Generate JWT Manually

If you have:
- User ID: `68d3753f9f99d6b73ae2d991` (from session response)
- AUTH_SECRET: (from your Next.js `.env` file)

Run this command in terminal:

```bash
node -e "const jwt=require('jsonwebtoken'); const secret='YOUR_AUTH_SECRET_HERE'; const userId='68d3753f9f99d6b73ae2d991'; const token=jwt.sign({sub:userId,userId:userId,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600},secret,{algorithm:'HS256'}); console.log(token);"
```

Replace `YOUR_AUTH_SECRET_HERE` with your actual AUTH_SECRET.

Then copy the output and set it as `auth_token` in Postman.

## Quick Test

After setting `auth_token` in Postman:

1. Run **"Step 1: Request Provisioning Token"**
2. Should return `provisioning_token` if auth_token is valid
3. If you get 401, check:
   - AUTH_SECRET matches between Next.js and mqtt-publisher-lite
   - User ID is correct
   - Token is not expired

## Session Response Structure

The `/api/auth/session` response typically looks like:

```json
{
  "user": {
    "id": "68d3753f9f99d6b73ae2d991",
    "email": "user@example.com",
    "name": "User Name"
  },
  "expires": "2025-12-31T23:59:59.000Z"
}
```

**The cookies contain encrypted session tokens - do NOT use them directly!**

Use the `user.id` from the response body to generate the JWT.

