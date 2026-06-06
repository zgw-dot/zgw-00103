import { UnauthorizedError } from '../../utils/errors';

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['alarm_acknowledge', 'alarm_close', 'device_manage', 'threshold_manage', 'import_readings', 'dry_run_import', 'export_audit', 'view_batches', 'export_batches', 'manage_row_remarks', 'manage_escalation_rules', 'view_escalation', 'claim_escalation_ticket', 'export_escalation', 'manage_calibration_plans', 'view_calibration_plans', 'export_calibration', 'manage_inspection_templates', 'submit_inspection', 'view_inspection', 'export_inspection'],
  manager: ['alarm_acknowledge', 'alarm_close', 'import_readings', 'dry_run_import', 'export_audit', 'view_batches', 'export_batches', 'manage_row_remarks', 'manage_escalation_rules', 'view_escalation', 'claim_escalation_ticket', 'export_escalation', 'manage_calibration_plans', 'view_calibration_plans', 'export_calibration', 'manage_inspection_templates', 'submit_inspection', 'view_inspection', 'export_inspection'],
  operator: ['import_readings', 'dry_run_import', 'export_audit', 'view_batches', 'export_batches', 'view_escalation', 'claim_escalation_ticket', 'export_escalation', 'view_calibration_plans', 'export_calibration', 'submit_inspection', 'view_inspection', 'export_inspection'],
  viewer: ['export_audit', 'view_batches', 'export_batches', 'view_escalation', 'export_escalation', 'view_calibration_plans', 'export_calibration', 'view_inspection', 'export_inspection'],
};

const USER_ROLES: Record<string, string[]> = {
  'admin': ['admin'],
  'manager_zhang': ['manager'],
  'operator_li': ['operator'],
  'viewer_wang': ['viewer'],
};

export function getPermissionsForUser(userId: string): string[] {
  const roles = USER_ROLES[userId] || [];
  const permissions = new Set<string>();
  for (const role of roles) {
    const rolePermissions = ROLE_PERMISSIONS[role] || [];
    for (const perm of rolePermissions) {
      permissions.add(perm);
    }
  }
  return Array.from(permissions);
}

export function hasPermission(userId: string, permission: string): boolean {
  const permissions = getPermissionsForUser(userId);
  return permissions.includes(permission);
}

export function checkPermission(userId: string, permission: string): void {
  if (!hasPermission(userId, permission)) {
    throw new UnauthorizedError(
      `用户"${userId}"没有"${permission}"操作权限，请联系管理员授权`,
      { userId, requiredPermission: permission }
    );
  }
}

export function checkAcknowledgePermission(userId: string): void {
  checkPermission(userId, 'alarm_acknowledge');
}

export function checkClosePermission(userId: string): void {
  checkPermission(userId, 'alarm_close');
}

export function checkImportPermission(userId: string): void {
  checkPermission(userId, 'import_readings');
}

export function checkExportPermission(userId: string): void {
  checkPermission(userId, 'export_audit');
}

export function checkDeviceManagePermission(userId: string): void {
  checkPermission(userId, 'device_manage');
}

export function checkThresholdManagePermission(userId: string): void {
  checkPermission(userId, 'threshold_manage');
}

export function checkDryRunPermission(userId: string): void {
  checkPermission(userId, 'dry_run_import');
}

export function checkViewBatchesPermission(userId: string): void {
  checkPermission(userId, 'view_batches');
}

export function checkExportBatchesPermission(userId: string): void {
  checkPermission(userId, 'export_batches');
}

export function checkManageRowRemarksPermission(userId: string): void {
  checkPermission(userId, 'manage_row_remarks');
}

export function checkManageEscalationRulesPermission(userId: string): void {
  checkPermission(userId, 'manage_escalation_rules');
}

export function checkViewEscalationPermission(userId: string): void {
  checkPermission(userId, 'view_escalation');
}

export function checkClaimEscalationTicketPermission(userId: string): void {
  checkPermission(userId, 'claim_escalation_ticket');
}

export function checkExportEscalationPermission(userId: string): void {
  checkPermission(userId, 'export_escalation');
}

export function checkManageCalibrationPlansPermission(userId: string): void {
  checkPermission(userId, 'manage_calibration_plans');
}

export function checkViewCalibrationPlansPermission(userId: string): void {
  checkPermission(userId, 'view_calibration_plans');
}

export function checkExportCalibrationPermission(userId: string): void {
  checkPermission(userId, 'export_calibration');
}

export function getAllRoles(): string[] {
  return Object.keys(ROLE_PERMISSIONS);
}

export function getAllPermissions(): string[] {
  const perms = new Set<string>();
  for (const rolePerms of Object.values(ROLE_PERMISSIONS)) {
    for (const perm of rolePerms) {
      perms.add(perm);
    }
  }
  return Array.from(perms);
}

export function getTestUsers(): Array<{ id: string; roles: string[]; permissions: string[] }> {
  return Object.entries(USER_ROLES).map(([id, roles]) => ({
    id,
    roles,
    permissions: getPermissionsForUser(id),
  }));
}

export function checkManageInspectionTemplatesPermission(userId: string): void {
  checkPermission(userId, 'manage_inspection_templates');
}

export function checkSubmitInspectionPermission(userId: string): void {
  checkPermission(userId, 'submit_inspection');
}

export function checkViewInspectionPermission(userId: string): void {
  checkPermission(userId, 'view_inspection');
}

export function checkExportInspectionPermission(userId: string): void {
  checkPermission(userId, 'export_inspection');
}
