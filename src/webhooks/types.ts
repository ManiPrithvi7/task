import type { MqttClientManager } from '../servers/mqttClient';
import type { WebhookConfig } from '../config/webhookConfig';

export type WebhookHandlerDeps = {
  mqttClient: MqttClientManager;
  topicRoot: string;
  webhookConfig: WebhookConfig;
  appEnv: string;
};
