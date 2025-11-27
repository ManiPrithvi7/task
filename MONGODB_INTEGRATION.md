# MongoDB Integration for mqtt-publisher-lite

## Overview

The `mqtt-publisher-lite` service now supports **dual storage modes** for device certificates:

1. **SQLite Mode** (Default): File-based storage using `better-sqlite3`
2. **MongoDB Mode**: Shared database with the main `mqtt-publisher` service

This allows you to run `mqtt-publisher-lite` either as a standalone service (SQLite) or integrated with the main service ecosystem (MongoDB).

## Architecture

### Storage Modes

#### SQLite Mode (Default)
- **Certificates**: Stored in local SQLite database (`certificates.db`)
- **Tokens**: Stored in memory
- **Use Case**: Standalone deployment, development, testing, edge devices
- **Dependencies**: None (no external database required)

#### MongoDB Mode
- **Certificates**: Stored in shared MongoDB database
- **Tokens**: Still stored in memory (lightweight, no persistence needed)
- **Use Case**: Production deployment alongside main `mqtt-publisher` service
- **Dependencies**: MongoDB instance (same as main service)

### Code Structure

#### Models (Mongoose)
All Mongoose models from `mqtt-publisher` have been copied to `mqtt-publisher-lite`:
- `User.ts` - User account model
- `Device.ts` - Device registration model
- `Social.ts` - Social account integration
- `DeviceACL.ts` - Device access control lists
- `DeviceCertificate.ts` - Device certificate model (primary for provisioning)

#### Services
- **mongoService.ts**: MongoDB connection and management
- **caService.ts**: Enhanced to support both storage backends
  - `constructor(config, dbPath?, useMongoose?)` - Storage mode selection
  - Automatic fallback to appropriate storage methods
  - Dual query methods for compatibility

#### Routes
- **provisioningRoutes.ts**: Updated to work with both storage types
  - Storage-agnostic certificate queries
  - Unified response format regardless of backend

## Configuration

### Environment Variables

```bash
# Enable MongoDB mode
MONGODB_ENABLED=true

# MongoDB connection URI
MONGODB_URI=mongodb://root:password@localhost:27017/statsmqtt?authSource=admin

# Database name (should match main mqtt-publisher service)
MONGODB_DB_NAME=statsmqtt
```

### Default Configuration (SQLite Mode)

```bash
# MongoDB disabled by default
MONGODB_ENABLED=false

# SQLite database path
CERTIFICATE_DB_PATH=./data/certificates.db
```

## Usage

### Development Mode (SQLite)

```bash
# No MongoDB required
npm run dev
```

Output:
```
✅ Provisioning services initialized {
  "storageMode": "SQLite"
}
```

### Production Mode (MongoDB)

```bash
# Set environment variables
export MONGODB_ENABLED=true
export MONGODB_URI="mongodb://root:password@localhost:27017/statsmqtt?authSource=admin"

# Start service
npm start
```

Output:
```
🗃️  MongoDB: Connected (statsmqtt)
✅ Provisioning services initialized {
  "storageMode": "MongoDB"
}
```

## API Behavior

All provisioning API endpoints work identically in both modes:

### POST /api/v1/onboarding
Issue JWT provisioning token for device registration.

### POST /api/v1/sign-csr
Sign device CSR and store certificate.
- **SQLite Mode**: Certificate stored in `certificates.db`
- **MongoDB Mode**: Certificate stored in MongoDB `device_certificates` collection

### GET /api/v1/certificates/:certificateId/download
Download device certificate and Root CA.

### GET /api/v1/certificates/:deviceId/status
Get certificate status for a device.

### DELETE /api/v1/certificates/:deviceId
Revoke device certificate.

## Database Schema Compatibility

Both storage modes use the same logical schema:

```typescript
interface DeviceCertificate {
  device_id: string;
  user_id: string | ObjectId;
  certificate: string;
  private_key?: string | null;
  ca_certificate: string;
  cn: string;
  fingerprint: string;
  status: 'active' | 'revoked' | 'expired';
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at?: Date | string | null;
  last_used?: Date | string | null;
}
```

## Migration Guide

### From SQLite to MongoDB

1. **Start MongoDB** (if not already running)
2. **Update Environment Variables**:
   ```bash
   MONGODB_ENABLED=true
   MONGODB_URI=your-mongodb-uri
   ```
3. **Restart Service**: Existing SQLite data remains intact but inactive
4. **Optional**: Migrate existing certificates using custom script

### From MongoDB to SQLite

1. **Update Environment Variables**:
   ```bash
   MONGODB_ENABLED=false
   ```
2. **Restart Service**: New certificates will be stored in SQLite

## Testing

### Test SQLite Mode
```bash
npm run dev
# Check logs for: storageMode: "SQLite"
```

### Test MongoDB Mode
```bash
export MONGODB_ENABLED=true
export MONGODB_URI="mongodb://root:password@localhost:27017/statsmqtt?authSource=admin"
npm run dev
# Check logs for: storageMode: "MongoDB"
```

### Test API Endpoints
```bash
# Issue token
curl -X POST http://localhost:3002/api/v1/onboarding \
  -H "Content-Type: application/json" \
  -d '{"device_id": "test-device-001"}'

# Check certificate status
curl http://localhost:3002/api/v1/certificates/test-device-001/status
```

## Benefits

### Standalone Mode (SQLite)
- ✅ Zero external dependencies
- ✅ Fast local storage
- ✅ Easy deployment
- ✅ Perfect for edge devices
- ✅ Simpler configuration

### Shared Database Mode (MongoDB)
- ✅ Centralized certificate management
- ✅ Shared data with main service
- ✅ Better scalability
- ✅ Advanced querying capabilities
- ✅ Production-ready

## Troubleshooting

### MongoDB Connection Failed
```
Failed to connect to MongoDB: connect ECONNREFUSED
```
**Solution**: Check MongoDB is running and `MONGODB_URI` is correct.

### Certificate Not Found (MongoDB Mode)
**Solution**: Ensure `MONGODB_DB_NAME` matches the main service database.

### Duplicate Index Warnings
**Solution**: All Mongoose models are optimized to avoid duplicate index definitions.

## Implementation Details

### CAService Dual Storage

```typescript
// SQLite mode
const caService = new CAService(config, './data/certificates.db', false);

// MongoDB mode
const caService = new CAService(config, undefined, true);

// Query (works with both)
const cert = await caService.findActiveCertificateByDeviceId(deviceId);
```

### Storage Detection

The `CAService` automatically selects the correct storage backend based on the `useMongoose` flag:

```typescript
if (this.useMongoose) {
  // Use Mongoose models
  return await DeviceCertificate.findOne({ device_id: deviceId });
} else {
  // Use SQLite
  return await this.certificateStore.findByDeviceId(deviceId);
}
```

## Dependencies

### Added Dependencies
```json
{
  "mongoose": "^8.0.0"
}
```

### No Breaking Changes
All existing functionality remains intact. MongoDB is opt-in via environment variables.

## Conclusion

The dual storage implementation provides maximum flexibility:
- **Development**: Use SQLite for simplicity
- **Production**: Use MongoDB for scale and integration
- **Migration**: Switch between modes without code changes

Choose the mode that best fits your deployment architecture.

