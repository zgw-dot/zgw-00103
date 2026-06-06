import { Threshold, AlarmType, Alarm, AlarmStatus, TemperatureReading } from '../../types';

export function checkThresholdViolation(
  temperature: number,
  threshold: Threshold
): { violated: boolean; type?: AlarmType; thresholdValue?: number } {
  if (temperature > threshold.maxTemp) {
    return { violated: true, type: AlarmType.HIGH_TEMP, thresholdValue: threshold.maxTemp };
  }
  if (temperature < threshold.minTemp) {
    return { violated: true, type: AlarmType.LOW_TEMP, thresholdValue: threshold.minTemp };
  }
  return { violated: false };
}

export function checkRecovery(
  temperature: number,
  alarm: Alarm,
  threshold: Threshold
): boolean {
  if (alarm.type === AlarmType.HIGH_TEMP) {
    return temperature <= threshold.maxTemp;
  }
  if (alarm.type === AlarmType.LOW_TEMP) {
    return temperature >= threshold.minTemp;
  }
  return false;
}

export function canAcknowledge(alarm: Alarm): boolean {
  return alarm.status === AlarmStatus.OPEN || alarm.status === AlarmStatus.RECOVERED;
}

export function canClose(alarm: Alarm): boolean {
  return alarm.status === AlarmStatus.RECOVERED || alarm.status === AlarmStatus.ACKNOWLEDGED;
}

export function canRecover(alarm: Alarm): boolean {
  return alarm.status === AlarmStatus.OPEN || alarm.status === AlarmStatus.ACKNOWLEDGED;
}

export function isAlarmActive(alarm: Alarm): boolean {
  return alarm.status === AlarmStatus.OPEN || alarm.status === AlarmStatus.ACKNOWLEDGED;
}

export function getAlarmStatusAfterAcknowledge(currentStatus: AlarmStatus): AlarmStatus {
  if (currentStatus === AlarmStatus.OPEN) {
    return AlarmStatus.ACKNOWLEDGED;
  }
  return currentStatus;
}

export function getAlarmStatusAfterRecovery(currentStatus: AlarmStatus): AlarmStatus {
  if (currentStatus === AlarmStatus.OPEN || currentStatus === AlarmStatus.ACKNOWLEDGED) {
    return AlarmStatus.RECOVERED;
  }
  return currentStatus;
}

export function shouldCreateNewAlarm(
  reading: TemperatureReading,
  openAlarms: Alarm[]
): boolean {
  const activeAlarm = openAlarms.find(a =>
    a.readingTime < reading.readingTime &&
    (a.status === AlarmStatus.OPEN || a.status === AlarmStatus.ACKNOWLEDGED)
  );
  return !activeAlarm;
}

export function findMatchingAlarmForRecovery(
  temperature: number,
  openAlarms: Alarm[],
  threshold: Threshold
): Alarm | null {
  for (const alarm of openAlarms) {
    if (alarm.type === AlarmType.HIGH_TEMP && temperature <= threshold.maxTemp) {
      return alarm;
    }
    if (alarm.type === AlarmType.LOW_TEMP && temperature >= threshold.minTemp) {
      return alarm;
    }
  }
  return null;
}
