import {
  DeviceRepository,
  ThresholdRepository,
  ImportBatchRepository,
  ReadingRepository,
  AlarmRepository,
  AuditRepository,
  BatchRowResultRepository,
  IdempotencyKeyRepository,
  BatchRowRemarkRepository,
  EscalationRuleRepository,
  EscalationTicketRepository,
  CalibrationPlanRepository,
  ReadingCorrectionRepository,
} from '../../storage/repositories';
import { getDatabase } from '../../storage/database';
import { DeviceService } from './DeviceService';
import { ThresholdService } from './ThresholdService';
import { AlarmService } from './AlarmService';
import { ReadingImportService } from './ReadingImportService';
import { AuditService } from './AuditService';
import { EscalationService } from './EscalationService';
import { CalibrationService } from './CalibrationService';

export class ServiceContainer {
  readonly deviceRepo: DeviceRepository;
  readonly thresholdRepo: ThresholdRepository;
  readonly importBatchRepo: ImportBatchRepository;
  readonly readingRepo: ReadingRepository;
  readonly alarmRepo: AlarmRepository;
  readonly auditRepo: AuditRepository;
  readonly batchRowResultRepo: BatchRowResultRepository;
  readonly idempotencyKeyRepo: IdempotencyKeyRepository;
  readonly batchRowRemarkRepo: BatchRowRemarkRepository;
  readonly escalationRuleRepo: EscalationRuleRepository;
  readonly escalationTicketRepo: EscalationTicketRepository;
  readonly calibrationPlanRepo: CalibrationPlanRepository;
  readonly readingCorrectionRepo: ReadingCorrectionRepository;

  readonly deviceService: DeviceService;
  readonly thresholdService: ThresholdService;
  readonly alarmService: AlarmService;
  readonly readingImportService: ReadingImportService;
  readonly auditService: AuditService;
  readonly escalationService: EscalationService;
  readonly calibrationService: CalibrationService;

  private static instance: ServiceContainer | null = null;
  private static initPromise: Promise<ServiceContainer> | null = null;

  private constructor() {
    this.deviceRepo = new DeviceRepository();
    this.thresholdRepo = new ThresholdRepository();
    this.importBatchRepo = new ImportBatchRepository();
    this.readingRepo = new ReadingRepository();
    this.alarmRepo = new AlarmRepository();
    this.auditRepo = new AuditRepository();
    this.batchRowResultRepo = new BatchRowResultRepository();
    this.idempotencyKeyRepo = new IdempotencyKeyRepository();
    this.batchRowRemarkRepo = new BatchRowRemarkRepository();
    this.escalationRuleRepo = new EscalationRuleRepository();
    this.escalationTicketRepo = new EscalationTicketRepository();
    this.calibrationPlanRepo = new CalibrationPlanRepository();
    this.readingCorrectionRepo = new ReadingCorrectionRepository();

    this.deviceService = new DeviceService(this.deviceRepo, this.auditRepo);
    this.thresholdService = new ThresholdService(this.thresholdRepo, this.auditRepo, this.deviceRepo);
    this.alarmService = new AlarmService(this.alarmRepo, this.auditRepo, this.deviceRepo, this.thresholdRepo);
    this.calibrationService = new CalibrationService(
      this.calibrationPlanRepo,
      this.readingCorrectionRepo,
      this.deviceRepo,
      this.auditRepo
    );
    this.readingImportService = new ReadingImportService(
      this.deviceRepo,
      this.readingRepo,
      this.importBatchRepo,
      this.batchRowResultRepo,
      this.batchRowRemarkRepo,
      this.auditRepo,
      this.alarmService,
      this.thresholdRepo,
      this.alarmRepo,
      this.idempotencyKeyRepo,
      this.calibrationService
    );
    this.auditService = new AuditService(this.auditRepo);
    this.escalationService = new EscalationService(
      this.escalationRuleRepo,
      this.escalationTicketRepo,
      this.alarmRepo,
      this.deviceRepo,
      this.auditRepo
    );
  }

  static async getInstance(): Promise<ServiceContainer> {
    if (ServiceContainer.instance) return ServiceContainer.instance;

    if (ServiceContainer.initPromise) return ServiceContainer.initPromise;

    ServiceContainer.initPromise = (async () => {
      await getDatabase();
      ServiceContainer.instance = new ServiceContainer();
      return ServiceContainer.instance;
    })();

    return ServiceContainer.initPromise;
  }

  static getInstanceSync(): ServiceContainer {
    if (!ServiceContainer.instance) {
      throw new Error('ServiceContainer not initialized. Call getInstance() first.');
    }
    return ServiceContainer.instance;
  }
}

export let services: ServiceContainer;

export async function initServices(): Promise<ServiceContainer> {
  services = await ServiceContainer.getInstance();
  return services;
}
