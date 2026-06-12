/**
 * Shared OTA event handling for MQTT /status and HTTP /ota/report.
 */

import { AuditEventType, getAuditService } from './auditService';
import type { OtaCommandPublisher } from './otaCommandPublisher';
import type { OtaService } from './otaService';
import { DeviceOtaState } from '../models/Device';
import { logger } from '../utils/logger';

export type OtaEventPayload = {
  type?: string;
  event?: string;
  version?: string;
  attempted_version?: string;
  reason?: string;
  reasons?: string[];
  boot_attempts?: number;
  progress?: number;
  status?: string;
};

function eventKey(payload: OtaEventPayload): string | undefined {
  return payload.type || payload.event || payload.status;
}

export class OtaEventHandler {
  constructor(
    private readonly otaService: OtaService,
    private readonly commandPublisher: OtaCommandPublisher
  ) {}

  async handle(deviceId: string, payload: OtaEventPayload): Promise<void> {
    const key = eventKey(payload);
    if (!key) return;

    switch (key) {
      case 'ota_progress':
        await this.otaService.updateOtaState(deviceId, DeviceOtaState.DOWNLOADING);
        break;

      case 'ota_validating':
        await this.otaService.updateOtaState(deviceId, DeviceOtaState.VALIDATING);
        break;

      case 'ota_success': {
        const version = payload.version || '';
        if (version) {
          await this.otaService.recordOtaSuccess(deviceId, version);
        }
        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_SUCCESS,
            deviceId,
            details: { version }
          })
          .catch(() => undefined);
        break;
      }

      case 'ota_rollback': {
        const version = payload.attempted_version || payload.version || '';
        const reason =
          payload.reason ||
          (Array.isArray(payload.reasons) ? payload.reasons.join('; ') : undefined);

        const { blocked, failures } = await this.otaService.recordRollbackFailure(
          deviceId,
          version,
          reason
        );

        void getAuditService()
          ?.logEvent({
            event: AuditEventType.OTA_ROLLBACK,
            deviceId,
            details: { version, reason, failures, blocked }
          })
          .catch(() => undefined);

        if (version) {
          await this.commandPublisher.publishRollbackAck(deviceId, version);
        }
        break;
      }

      default:
        logger.debug('[OTA] Ignored status event', { deviceId, key });
    }
  }
}
