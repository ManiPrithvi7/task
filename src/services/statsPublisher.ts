import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService } from './deviceService';

interface DeviceStats {
  followers: number;
  following: number;
  posts: number;
  engagement: number;
  lastMilestone: number;
}

export class StatsPublisher {
  private mqttClient: MqttClientManager;
  private deviceService: DeviceService;
  private publishInterval: number;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private deviceStats: Map<string, DeviceStats> = new Map();
  private lastCleanupTime: number = Date.now();

  constructor(
    mqttClient: MqttClientManager,
    deviceService: DeviceService,
    publishInterval: number = 15000
  ) {
    this.mqttClient = mqttClient;
    this.deviceService = deviceService;
    this.publishInterval = publishInterval;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Stats publisher already running');
      return;
    }

    this.isRunning = true;
    logger.info('📈 Starting stats publisher', {
      interval: `${this.publishInterval / 1000}s`
    });

    await this.publishStats();

    this.intervalTimer = setInterval(async () => {
      await this.publishStats();
    }, this.publishInterval);
  }

  async stop(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.isRunning = false;
    logger.info('Stats publisher stopped');
  }

  private async publishStats(): Promise<void> {
    try {
      await this.cleanupInactiveDeviceStats();

      const allDevices = await this.deviceService.getAllDevices();
      const activeDevices = Array.from(allDevices.values()).filter(d => d.status === 'active');
      const inactiveCount = allDevices.size - activeDevices.length;

      if (activeDevices.length === 0) {
        logger.debug('No active devices to publish stats to', {
          total: allDevices.size,
          inactive: inactiveCount
        });
        return;
      }

      logger.info('📊 Publishing stats to active devices', {
        active: activeDevices.length,
        inactive: inactiveCount,
        total: allDevices.size
      });

      let publishedCount = 0;
      let skippedCount = 0;

      for (const device of activeDevices) {
        try {
          const currentDevice = await this.deviceService.getDevice(device.deviceId);
          if (currentDevice && currentDevice.status === 'active') {
            await this.publishDeviceStats(device.deviceId);
            publishedCount++;
          } else {
            logger.debug('Skipping device - no longer active', { deviceId: device.deviceId });
            skippedCount++;
          }
        } catch (error: any) {
          logger.error('Failed to publish stats for device', {
            deviceId: device.deviceId,
            error: error.message
          });
        }
      }

      logger.info('✅ Stats published', {
        published: publishedCount,
        skipped: skippedCount,
        inactive: inactiveCount
      });
    } catch (error: any) {
      logger.error('Error publishing stats', { error: error.message });
    }
  }

  private async publishDeviceStats(deviceId: string): Promise<void> {
    if (!this.deviceStats.has(deviceId)) {
      this.deviceStats.set(deviceId, {
        followers: 9950 + Math.floor(Math.random() * 40),
        following: 500 + Math.floor(Math.random() * 200),
        posts: 100 + Math.floor(Math.random() * 50),
        engagement: 3.5 + Math.random() * 1.5,
        lastMilestone: 0
      });
    }

    const stats = this.deviceStats.get(deviceId)!;
    const oldFollowers = stats.followers;

    const followerChange = 5 + Math.floor(Math.random() * 10);
    stats.followers += followerChange;
    stats.following += Math.random() < 0.1 ? 1 : 0;
    stats.engagement = 10.0 + Math.random() * 10.0;

    await this.publishFollowersMetric(deviceId, stats.followers);
    await this.publishEngagementMetric(deviceId, stats.engagement);

    if (Math.random() < 0.3) {
      await this.publishFollowingMetric(deviceId, stats.following);
    }

    const milestone = this.checkMilestoneCrossed(oldFollowers, stats.followers);
    if (milestone && milestone !== stats.lastMilestone) {
      await this.publishMilestone(deviceId, milestone);
      stats.lastMilestone = milestone;
    }

    if (Math.random() < 0.15) {
      await this.publishCrosspost(deviceId);
    }
  }

  private async publishFollowersMetric(deviceId: string, followers: number): Promise<void> {
    const message = {
      version: '1.1',
      id: `ig_${Math.random().toString(16).substr(2, 8)}`,
      type: 'state',
      subtype: 'update_metric',
      priority: 1,
      interruptible: true,
      payload: {
        metric: 'followers',
        value: followers,
        label: 'Followers'
      }
    };

    await this.mqttClient.publish({
      topic: `statsnapp/${deviceId}/update`,
      payload: JSON.stringify(message),
      qos: 1,
      retain: false
    });

    logger.info('📈 Published followers metric', { deviceId, followers });
  }

  private async publishEngagementMetric(deviceId: string, engagement: number): Promise<void> {
    const message = {
      version: '1.1',
      id: `ig_${Math.random().toString(16).substr(2, 8)}`,
      type: 'state',
      subtype: 'update_metric',
      priority: 1,
      interruptible: true,
      payload: {
        metric: 'engagement',
        value: parseFloat(engagement.toFixed(2)),
        label: 'Engagement Rate'
      }
    };

    await this.mqttClient.publish({
      topic: `statsnapp/${deviceId}/update`,
      payload: JSON.stringify(message),
      qos: 1,
      retain: false
    });

    logger.info('📊 Published engagement metric', {
      deviceId,
      engagement: engagement.toFixed(2)
    });
  }

  private async cleanupInactiveDeviceStats(): Promise<void> {
    const now = Date.now();
    const CLEANUP_INTERVAL = 60000;

    if (now - this.lastCleanupTime < CLEANUP_INTERVAL) {
      return;
    }

    this.lastCleanupTime = now;

    try {
      const allDevices = await this.deviceService.getAllDevices();
      const activeDeviceIds = new Set(
        Array.from(allDevices.values())
          .filter(d => d.status === 'active')
          .map(d => d.deviceId)
      );

      let cleanedCount = 0;
      for (const deviceId of this.deviceStats.keys()) {
        if (!activeDeviceIds.has(deviceId)) {
          this.deviceStats.delete(deviceId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.debug('Cleaned up inactive device stats', {
          removed: cleanedCount,
          remaining: this.deviceStats.size
        });
      }
    } catch (error: any) {
      logger.error('Error cleaning up device stats', { error: error.message });
    }
  }

  private async publishFollowingMetric(deviceId: string, following: number): Promise<void> {
    const message = {
      version: '1.1',
      id: `ig_${Math.random().toString(16).substr(2, 8)}`,
      type: 'state',
      subtype: 'update_metric',
      priority: 1,
      interruptible: true,
      payload: {
        metric: 'following',
        value: following,
        label: 'Following'
      }
    };

    await this.mqttClient.publish({
      topic: `statsnapp/${deviceId}/update`,
      payload: JSON.stringify(message),
      qos: 1,
      retain: false
    });

    logger.debug('📊 Published following metric', { deviceId, following });
  }

  private async publishMilestone(deviceId: string, followers: number): Promise<void> {
    const milestone = this.getMilestone(followers);

    const message = {
      version: '1.1',
      id: `ig_${Math.random().toString(16).substr(2, 8)}`,
      type: 'event',
      subtype: 'milestone_reached',
      priority: 3,
      interruptible: false,
      payload: {
        milestone: milestone,
        current_value: followers,
        message: `Congratulations! You've reached ${milestone.toLocaleString()} followers! 🎉`,
        animation: 'confetti',
        sound: 'celebration.wav',
        color_palette: 'gold'
      }
    };

    await this.mqttClient.publish({
      topic: `statsnapp/${deviceId}/milestone`,
      payload: JSON.stringify(message),
      qos: 1,
      retain: false
    });

    logger.info('🎯 Published milestone', { deviceId, milestone, followers });
  }

  private async publishCrosspost(deviceId: string): Promise<void> {
    const destinations = ['TikTok', 'YouTube', 'Twitter', 'Facebook'];
    const destination = destinations[Math.floor(Math.random() * destinations.length)];

    const message = {
      version: '1.1',
      id: `ig_${Math.random().toString(16).substr(2, 8)}`,
      type: 'event',
      subtype: 'repurpose_ready',
      priority: 2,
      interruptible: true,
      payload: {
        destination,
        label: `Cross-post to ${destination} for maximum reach!`,
        animation: 'zoom_in',
        sound: 'crosspost-ready.wav',
        color_palette: 'instagram'
      }
    };

    await this.mqttClient.publish({
      topic: `statsnapp/${deviceId}/update`,
      payload: JSON.stringify(message),
      qos: 1,
      retain: false
    });

    logger.info('🔄 Published crosspost', { deviceId, destination });
  }

  private checkMilestoneCrossed(oldFollowers: number, newFollowers: number): number | null {
    const milestones = [10000, 15000, 20000, 25000, 50000, 100000, 250000, 500000, 1000000];
    
    for (const milestone of milestones) {
      if (oldFollowers < milestone && newFollowers >= milestone) {
        return milestone;
      }
    }
    return null;
  }

  private getMilestone(followers: number): number {
    const milestones = [10000, 15000, 20000, 25000, 50000, 100000, 250000, 500000, 1000000];
    
    for (let i = milestones.length - 1; i >= 0; i--) {
      if (followers >= milestones[i]) {
        return milestones[i];
      }
    }
    return 10000;
  }
}

