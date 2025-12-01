# Postman Setup Guide for StatsMQTT Lite Provisioning

## Quick Start

1. **Import Collection and Environment**
   - Import `StatsMQTT-Lite-Provisioning.postman_collection.json`
   - Import `StatsMQTT-Lite-Provisioning.postman_environment.json`

2. **Set Environment Variables**
   - `base_url`: `http://localhost:3002` (mqtt-publisher-lite server)
   - `nextjs_base_url`: `http://localhost:3000` (Next.js app)
   - `auth_secret`: Your `AUTH_SECRET` from Next.js `.env` file
   - `auth_token`: JWT token signed with AUTH_SECRET (see below)

## Getting the Auth Token

The `auth_token` must be a JWT signed with `AUTH_SECRET` that contains the user ID. The session token from Next.js Auth.js is encrypted, so you have two options:

### Option 1: Create Next.js API Route (Recommended)

Create a new API route in your Next.js app: `/api/auth/token`

```typescript
// app/api/auth/token/route.ts
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

Then use Postman to call `GET {{nextjs_base_url}}/api/auth/token` to get the JWT.

### Option 2: Manual JWT Generation

If you have `AUTH_SECRET`, you can generate a JWT manually:

```javascript
// In Postman Pre-request Script or Node.js
const jwt = require('jsonwebtoken');

const authSecret = pm.environment.get('auth_secret');
const userId = '68d3753f9f99d6b73ae2d991'; // Your user ID

const token = jwt.sign(
  {
    sub: userId,
    userId: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  },
  authSecret,
  { algorithm: 'HS256' }
);

pm.environment.set('auth_token', token);
```

### Option 3: Use Browser Console

1. Open your Next.js app in browser
2. Open DevTools Console
3. Run:
```javascript
fetch('/api/auth/token')
  .then(r => r.json())
  .then(data => console.log('Auth Token:', data.auth_token));
```

## Testing Flow

### Step 1: Set AUTH_SECRET
1. Open Postman Environment
2. Set `auth_secret` to your Next.js `AUTH_SECRET` value
3. Set `auth_token` (using one of the methods above)

### Step 2: Request Provisioning Token
1. Run: **"Step 1: Request Provisioning Token"**
2. Should return `provisioning_token` (automatically saved)
3. Verify: Check that `provisioning_token` variable is set

### Step 3: Generate Sample CSR (for testing)
1. Run: **"Generate Sample CSR"**
2. This creates a dummy CSR for testing
3. **Note:** For real testing, use a valid CSR from your device

### Step 4: Sign CSR
1. Run: **"Step 2: Sign CSR (with Bearer Token)"**
2. Should return certificate and CA certificate
3. Verify: Check that certificate is valid PEM format

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `base_url` | mqtt-publisher-lite server URL | `http://localhost:3002` |
| `nextjs_base_url` | Next.js app URL | `http://localhost:3000` |
| `auth_secret` | AUTH_SECRET for JWT signing | `your-secret-key-here` |
| `auth_token` | JWT token for authentication | `eyJhbGciOiJIUzI1NiIs...` |
| `provisioning_token` | Token from onboarding step | Auto-saved |
| `device_id` | Device identifier | Auto-saved |
| `certificate_id` | Certificate MongoDB ID | Auto-saved |
| `sample_csr` | Sample CSR for testing | Auto-generated |

## Error Scenarios Testing

The collection includes error scenario tests:
- Missing auth_token
- Invalid auth_token
- Missing device_id
- Missing provisioning_token
- Invalid CSR format

Run these to verify error handling works correctly.

## Important Notes

1. **AUTH_SECRET**: Must match between Next.js app and mqtt-publisher-lite
2. **User ID Format**: Must be MongoDB ObjectId (24 hex characters)
3. **Token Expiration**: auth_token should be valid (not expired)
4. **Device Association**: Device must exist in database and be associated with the user
5. **CSR Format**: Must be Base64-encoded PEM or direct PEM string with BEGIN/END markers

