import { Router } from 'express';
import { AppConfig } from '../config';
import { CAService } from '../services/caService';

export interface ConfigRoutesDeps {
  config: AppConfig;
  caService?: CAService;
}

export function createConfigRoutes(deps: ConfigRoutesDeps) {
  const router = Router();

  /**
   * @swagger
   * /api/v1/mqtt-config:
   *   get:
   *     tags: [Config]
   *     summary: MQTT broker configuration
   *     description: Returns broker host, port, and optional base64-encoded root CA for device firmware.
   *     responses:
   *       200:
   *         description: Broker configuration
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/MqttConfigResponse'
   *       500:
   *         $ref: '#/components/responses/InternalError'
   */
  router.get('/mqtt-config', async (req, res) => {
    try {
      const broker = deps.config.mqtt.broker;
      const port = deps.config.mqtt.port;

      let caCertBase64: string | null = null;
      if (deps.caService) {
        try {
          const pem = deps.caService.getRootCACertificate();
          if (pem) {
            caCertBase64 = Buffer.from(pem, 'utf8').toString('base64');
          }
        } catch (err) {
          // swallow; we'll return null if CA not available
          caCertBase64 = null;
        }
      }

      res.json({
        broker,
        port,
        ca_cert: caCertBase64
      });
    } catch (err: any) {
      res.status(500).json({
        error: 'failed_to_fetch_config',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  });

  return router;
}

