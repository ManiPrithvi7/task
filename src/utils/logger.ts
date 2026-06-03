import winston from 'winston';

const defaultLogLevel = process.env.LOG_LEVEL || 'info';

export const logger = winston.createLogger({
  level: defaultLogLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'mqtt-publisher-lite' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      )
    })
  ]
});

/** Apply log level from AppConfig after loadConfig() (canonical source: config.app.logLevel). */
export function configureLogger(level: string): void {
  const normalized = level?.trim() || 'info';
  logger.level = normalized;
  for (const transport of logger.transports) {
    transport.level = normalized;
  }
}
