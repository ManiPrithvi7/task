/**
 * @swagger
 * tags:
 *   - name: Health
 *     description: Liveness and readiness probes
 *   - name: Sessions
 *     description: Session storage (testing)
 *   - name: Devices
 *     description: Device registry (testing)
 *   - name: Provisioning
 *     description: Device certificate provisioning (requires PROVISIONING_ENABLED)
 *   - name: Lifecycle
 *     description: Certificate renewal and promotion
 *   - name: Recovery
 *     description: Factory-reset certificate recovery
 *   - name: Config
 *     description: MQTT broker configuration for devices
 *   - name: Webhooks
 *     description: External webhook ingress
 *   - name: Connections
 *     description: Social connection validation fan-out
 *   - name: Deprecated
 *     description: Removed or superseded endpoints
 *
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: User session JWT from the dashboard
 *     ProvisioningToken:
 *       type: apiKey
 *       in: header
 *       name: Authorization
 *       description: Bearer provisioning token issued by POST /api/v1/onboarding
 *     ApiKeyAuth:
 *       type: apiKey
 *       in: header
 *       name: x-api-key
 *       description: Connections validate API key (CONNECTIONS_VALIDATE_API_KEY)
 *     MtlsClientCert:
 *       type: apiKey
 *       in: header
 *       name: x-forwarded-client-cert
 *       description: Client certificate PEM forwarded by an mTLS-capable reverse proxy
 *
 *   schemas:
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: false
 *         error:
 *           type: string
 *         code:
 *           type: string
 *         timestamp:
 *           type: string
 *           format: date-time
 *
 *     SimpleError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *
 *     GoneResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *         reason:
 *           type: string
 *         timestamp:
 *           type: string
 *           format: date-time
 *
 *     HealthResponse:
 *       type: object
 *       properties:
 *         status:
 *           type: string
 *           example: ok
 *         timestamp:
 *           type: string
 *           format: date-time
 *         mqtt:
 *           type: object
 *           properties:
 *             connected:
 *               type: boolean
 *             pendingAcks:
 *               type: integer
 *         storage:
 *           type: object
 *           properties:
 *             sessions:
 *               type: integer
 *             devices:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 active:
 *                   type: integer
 *                 inactive:
 *                   type: integer
 *
 *     ReadinessResponse:
 *       type: object
 *       properties:
 *         ready:
 *           type: boolean
 *         note:
 *           type: string
 *         error:
 *           type: string
 *
 *     OnboardingRequest:
 *       type: object
 *       required:
 *         - device_id
 *       properties:
 *         device_id:
 *           type: string
 *
 *     SignCsrRequest:
 *       type: object
 *       required:
 *         - csr
 *         - token
 *       properties:
 *         csr:
 *           type: string
 *           description: PEM or base64-encoded CSR
 *         token:
 *           type: string
 *           description: Provisioning token from onboarding
 *         device_id:
 *           type: string
 *
 *     CertificateResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         device_id:
 *           type: string
 *         certificate:
 *           type: string
 *         ca_certificate:
 *           type: string
 *         expires_at:
 *           type: string
 *           format: date-time
 *         fingerprint:
 *           type: string
 *         slot:
 *           type: string
 *         timestamp:
 *           type: string
 *           format: date-time
 *
 *     MqttConfigResponse:
 *       type: object
 *       properties:
 *         broker:
 *           type: string
 *         port:
 *           type: integer
 *         ca_cert:
 *           type: string
 *           nullable: true
 *           description: Base64-encoded PEM root CA, or null if unavailable
 *
 *     RecoveryGenerateSessionRequest:
 *       type: object
 *       required:
 *         - device_id
 *         - token
 *       properties:
 *         device_id:
 *           type: string
 *         token:
 *           type: string
 *           description: Device recovery JWT from dashboard
 *
 *     ConnectionValidateRequest:
 *       type: object
 *       required:
 *         - userId
 *         - event
 *       properties:
 *         userId:
 *           type: string
 *         event:
 *           type: string
 *           enum:
 *             - social.connected
 *             - social.disconnected
 *             - campaign.updated
 *             - campaign.deleted
 *             - integrations.refresh
 *         fanout:
 *           type: boolean
 *           default: true
 *         provider:
 *           type: string
 *           enum: [instagram, google_business, shopify, square]
 *
 *   responses:
 *     Unauthorized:
 *       description: Missing or invalid authentication
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     Forbidden:
 *       description: Authenticated but not permitted
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     NotFound:
 *       description: Resource not found
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     TooManyRequests:
 *       description: Rate limit exceeded
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     ServiceUnavailable:
 *       description: Dependent service unavailable
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     InternalError:
 *       description: Internal server error
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SimpleError'
 */

export {};
