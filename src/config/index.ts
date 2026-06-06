import path from 'path';

export const config = {
  port: process.env.PORT || 3000,
  database: {
    path: process.env.DB_PATH || path.join(process.cwd(), 'data', 'cold_chain.db'),
  },
  defaultThreshold: {
    minTemp: -25,
    maxTemp: -15,
  },
  roles: {
    alarmManager: ['alarm_acknowledge', 'alarm_close'],
  },
  csv: {
    dateFormats: ['YYYY-MM-DD HH:mm:ss', 'YYYY/MM/DD HH:mm:ss', 'ISO8601'],
    maxFileSize: 10 * 1024 * 1024,
  },
} as const;
