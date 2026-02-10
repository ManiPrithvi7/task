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
   * GET /v1/mqtt-config
   * Returns broker connection info for devices to consume.
   *
   * Response:
   * {
   *   broker: string,
   *   port: number,
   *   ca_cert: string | null   // base64-encoded PEM or null
   * }
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

