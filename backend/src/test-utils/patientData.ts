import type { Prisma } from '@prisma/client';
import { toDbData } from '../patients/patient.mapper.js';

/**
 * Prisma `create` data for a throwaway patient, with fields encrypted and
 * blind indexes set exactly as the patients API would store them.
 */
export function testPatientData(
  registeredClinicId: string,
  createdById: string,
  overrides: Partial<{ firstName: string; lastName: string; mobileNumber: string; email: string }> = {},
): Prisma.PatientUncheckedCreateInput {
  return {
    ...(toDbData({
      firstName: 'Test',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
      sex: 'FEMALE',
      mobileNumber: '+639171234567',
      ...overrides,
    }) as Prisma.PatientUncheckedCreateInput),
    registeredClinicId,
    createdById,
  };
}
