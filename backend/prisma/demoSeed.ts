/**
 * DEMO SEED: loads sample data only. One file: the fake patients, the sample
 * images, and the code that saves them.
 *
 *   npm run db:seed:demo --workspace backend      (or: npm run db:reseed, to wipe and reload)
 *   tsx prisma/demoSeed.ts --if-enabled           (what Render runs at start; needs DEMO_SEED=true)
 *
 * Rules:
 *  - prisma/seed.ts is the dev seed. It is left as it is and refuses to run in
 *    production, which is correct. This is a separate seed for the demo site.
 *  - It creates NO user accounts. The doctor and secretary accounts are made
 *    separately; this attaches the data to the first active ones it finds.
 *  - Patients are saved through toDbData, the same way seed.ts does, so every
 *    sensitive field is encrypted and the search indexes are filled.
 *  - It refuses to run on a database that already holds real patients, and does
 *    nothing if the demo data is already there.
 *  - In production it only runs when DEMO_SEED=true.
 *
 * Layout: 1. sample patients  2. sample images  3. the seed  4. entry point.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { Prisma } from '@prisma/client';
import {
  EXAM_LOOKUP_VERSION,
  LAB_LOOKUP_VERSION,
  evaluateRange,
  toLogMAR,
} from '@clinic/schemas';
import { prisma } from '../src/prisma.js';
import { encrypt } from '../src/lib/fieldCrypto.js';
import { toDbData } from '../src/patients/patient.mapper.js';
import { signatureHash, toNoteDbData, type NoteContent } from '../src/encounters/encounter.mapper.js';
import { checkMedicationSafety } from '../src/medications/medicationSafety.js';
import { getDrugReference } from '../src/medications/drugReference.js';
import { putObjectEncrypted } from '../src/clinicalImages/s3Client.js';
import { recordAudit, SYSTEM_ACTOR } from '../src/audit/record.js';
import { AuditActions } from '../src/audit/actions.js';
import type { DiagnosisItem } from '@clinic/schemas';

// ============================================================================
// 1. Sample patients (all invented)
// ============================================================================

/**
 * Everything below is invented. Names, phone numbers (the 555 range) and
 * addresses do not belong to real people. Dates are written as "days ago" or
 * "days from now" so the data stays fresh whenever the seed runs.
 * The patients differ on purpose (age, diagnosis, number of visits, appointment
 * or none, labs, images, follow-ups) so every screen has full and empty states.
 */
export type ClinicKey = 'uerm' | 'tamesis' | 'happy';
export type EyeKey = 'OD' | 'OS' | 'OU';
/** [eye, field, value, unit?] using the fields in EXAM_FIELDS. */
export type FindingTuple = [EyeKey, string, string, string?];

export interface DemoVisit {
  daysAgo: number;
  type: 'NEW_PATIENT' | 'FOLLOW_UP' | 'PROCEDURE' | 'WALK_IN';
  /** Booked through an appointment (marked COMPLETED). False = walk-in or unbooked. */
  booked: boolean;
  chiefComplaint: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  diagnoses: DiagnosisItem[];
  findings: FindingTuple[];
  /** false = still a draft, so the visit stays OPEN. */
  signed: boolean;
  addendum?: { reason: string; text: string };
}

export interface DemoLab {
  daysAgo: number;
  test: string;
  value: string;
  unit: string;
  range?: string;
  lab: string;
  /** Index into the patient's visits, when the result belongs to one. */
  visit?: number;
}

export interface DemoMedication {
  name: string;
  strength?: string;
  dose: string;
  frequency: string;
  route: string;
  instructions?: string;
  indication?: string;
  startDaysAgo: number;
  endDaysAgo?: number;
  status?: 'ACTIVE' | 'ON_HOLD' | 'DISCONTINUED';
  source?: 'PRESCRIBED_HERE' | 'PATIENT_REPORTED' | 'OTHER_DOCTOR' | 'OTC';
  /** Why the Doctor went ahead after a safety alert. Used only if the check raises alerts. */
  ackReason?: string;
  /** This entry replaces the earlier medication at this index (a dose change). */
  replaces?: number;
}

export interface DemoAppointment {
  /** Negative = past. Only for appointments that are NOT tied to a visit above. */
  daysFromNow: number;
  hour: number;
  status: 'SCHEDULED' | 'CONFIRMED' | 'CANCELLED' | 'NO_SHOW';
  reason: string;
  visitType: string;
  cancelReason?: string;
}

export interface DemoFollowUp {
  dueInDays: number; // negative = overdue
  taskType: 'FOLLOW_UP' | 'CHECK_UP' | 'LAB_TEST' | 'INJECTION' | 'PROCEDURE';
  reason: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  status?: 'OPEN' | 'COMPLETED' | 'DECLINED' | 'UNREACHABLE';
  closureNote?: string;
  /** Visit index this task was set from. */
  visit?: number;
}

export interface DemoImage {
  kind: 'fundus' | 'oct' | 'slit' | 'topography' | 'external';
  caption: string;
  visit?: number;
}

export interface DemoPatient {
  key: string;
  clinic: ClinicKey;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth: string;
  sex: 'MALE' | 'FEMALE';
  civilStatus?: string;
  occupation?: string;
  mobile: string;
  alternatePhone?: string;
  email?: string;
  address: string;
  emergencyName?: string;
  emergencyPhone?: string;
  hmo?: { provider: string; member: string; validUntil: string };
  philhealth?: string;
  referral?: string;
  medicalHistory?: string;
  ophthalmicHistory?: string;
  /** Reminder consent: which channels were granted, and whether one was later withdrawn. */
  reminders: Array<'SMS' | 'EMAIL'>;
  withdrawnReminder?: boolean;
  allergies?: Array<{ allergen: string; reaction: string; severity: 'MILD' | 'MODERATE' | 'SEVERE' }>;
  visits: DemoVisit[];
  labs?: DemoLab[];
  medications?: DemoMedication[];
  appointments?: DemoAppointment[];
  followUps?: DemoFollowUp[];
  images?: DemoImage[];
}

const dx = (code: string, label: string, eye?: EyeKey): DiagnosisItem =>
  (eye ? { code, label, eye } : { code, label }) as DiagnosisItem;

export const DEMO_PATIENTS: DemoPatient[] = [
  // 1. Diabetic, three visits, labs over time, overdue retina check, upcoming appointment.
  {
    key: 'santos',
    clinic: 'uerm',
    firstName: 'Maria Clara',
    middleName: 'Reyes',
    lastName: 'Santos',
    dateOfBirth: '1962-03-04',
    sex: 'FEMALE',
    civilStatus: 'Married',
    occupation: 'Retired teacher',
    mobile: '09175550101',
    email: 'maria.santos.demo@example.com',
    address: '12 Mabini St., Project 4, Quezon City',
    emergencyName: 'Ramon Santos',
    emergencyPhone: '09175550102',
    philhealth: '12-345678901-2',
    referral: 'Endocrinologist',
    medicalHistory: 'Type 2 diabetes since 2011. Hypertension. On metformin and losartan.',
    ophthalmicHistory: 'Wears bifocals. No prior eye surgery.',
    reminders: ['SMS', 'EMAIL'],
    visits: [
      {
        daysAgo: 240, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Blurring of vision in both eyes for 3 months',
        subjective: 'Gradual blurring, worse at night. Last eye exam 4 years ago.',
        objective: 'VA 20/40 OD, 20/50 OS. Dot-blot hemorrhages in the posterior pole of both eyes.',
        assessment: 'Mild non-proliferative diabetic retinopathy, both eyes.',
        plan: 'Tighten glucose control. Repeat dilated exam in 4 months. HbA1c request.',
        diagnoses: [dx('E11.329', 'Type 2 diabetes with mild NPDR without macular edema')],
        findings: [['OD', 'VA', '20/40', 'Snellen'], ['OS', 'VA', '20/50', 'Snellen'], ['OD', 'IOP', '15', 'mmHg'], ['OS', 'IOP', '16', 'mmHg'], ['OD', 'MACULA', 'No edema'], ['OS', 'MACULA', 'No edema']],
        signed: true,
      },
      {
        daysAgo: 120, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Scheduled recheck',
        subjective: 'Vision unchanged. Taking medicines regularly.',
        objective: 'VA 20/40 OD, 20/40 OS. More dot hemorrhages inferotemporal OD. No macular edema on exam.',
        assessment: 'Mild NPDR, stable. HbA1c improved.',
        plan: 'Continue current management. Recheck in 4 months with fundus photos.',
        diagnoses: [dx('E11.329', 'Type 2 diabetes with mild NPDR without macular edema')],
        findings: [['OD', 'VA', '20/40', 'Snellen'], ['OS', 'VA', '20/40', 'Snellen'], ['OD', 'IOP', '14', 'mmHg'], ['OS', 'IOP', '15', 'mmHg'], ['OD', 'MACULA', 'No edema'], ['OS', 'MACULA', 'No edema']],
        signed: true,
        addendum: { reason: 'Lab result received after the visit', text: 'HbA1c from outside laboratory is 7.4%. Counselled by phone to continue current medicines.' },
      },
      {
        daysAgo: 21, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Routine diabetic eye check',
        subjective: 'No new symptoms. Occasional floaters OS.',
        objective: 'VA 20/30 OD, 20/40 OS. Fundus photos taken. Scattered hemorrhages unchanged.',
        assessment: 'Mild NPDR, stable over 8 months.',
        plan: 'Next dilated exam in 3 months. Report sudden vision loss immediately.',
        diagnoses: [dx('E11.329', 'Type 2 diabetes with mild NPDR without macular edema')],
        findings: [['OD', 'VA', '20/30', 'Snellen'], ['OS', 'VA', '20/40', 'Snellen'], ['OD', 'IOP', '15', 'mmHg'], ['OS', 'IOP', '14', 'mmHg'], ['OD', 'MACULA', 'No edema'], ['OS', 'MACULA', 'No edema']],
        signed: true,
      },
    ],
    labs: [
      { daysAgo: 250, test: 'HbA1c', value: '8.1', unit: '%', range: '<5.7', lab: 'Hi-Precision Diagnostics', visit: 0 },
      { daysAgo: 128, test: 'HbA1c', value: '7.4', unit: '%', range: '<5.7', lab: 'Hi-Precision Diagnostics', visit: 1 },
      { daysAgo: 30, test: 'HbA1c', value: '6.9', unit: '%', range: '<5.7', lab: 'Hi-Precision Diagnostics', visit: 2 },
      { daysAgo: 250, test: 'Fasting blood sugar', value: '162', unit: 'mg/dL', range: '70-100', lab: 'Hi-Precision Diagnostics', visit: 0 },
      { daysAgo: 30, test: 'Fasting blood sugar', value: '118', unit: 'mg/dL', range: '70-100', lab: 'Hi-Precision Diagnostics', visit: 2 },
      { daysAgo: 30, test: 'Creatinine', value: '0.9', unit: 'mg/dL', range: '0.6-1.1', lab: 'Hi-Precision Diagnostics' },
    ],
    medications: [
      { name: 'Metformin', strength: '500 mg', dose: '1 tablet', frequency: 'twice a day', route: 'oral', indication: 'Type 2 diabetes', startDaysAgo: 3000, source: 'OTHER_DOCTOR' },
      { name: 'Artificial tears', dose: '1 drop', frequency: 'as needed', route: 'ophthalmic', instructions: 'Both eyes when dry', startDaysAgo: 120, source: 'PRESCRIBED_HERE' },
    ],
    appointments: [{ daysFromNow: 12, hour: 14, status: 'CONFIRMED', reason: 'Dilated diabetic eye exam', visitType: 'Follow-up' }],
    followUps: [
      { dueInDays: -9, taskType: 'CHECK_UP', reason: 'Dilated retinal exam and OCT, 3 months after last visit', priority: 'HIGH', visit: 2 },
      { dueInDays: 30, taskType: 'LAB_TEST', reason: 'Repeat HbA1c before next visit', priority: 'NORMAL', visit: 2 },
    ],
    images: [
      { kind: 'fundus', caption: 'Right fundus, mild NPDR', visit: 2 },
      { kind: 'fundus', caption: 'Left fundus, mild NPDR', visit: 2 },
    ],
  },

  // 2. Glaucoma, four visits so the IOP trend shows, two drops, no upcoming appointment.
  {
    key: 'villanueva',
    clinic: 'uerm',
    firstName: 'Roberto',
    lastName: 'Villanueva',
    dateOfBirth: '1950-07-21',
    sex: 'MALE',
    civilStatus: 'Widowed',
    occupation: 'Retired engineer',
    mobile: '09185550111',
    alternatePhone: '028555-0112',
    address: '48 Katipunan Ave., Loyola Heights, Quezon City',
    emergencyName: 'Elena Villanueva-Cruz',
    emergencyPhone: '09185550113',
    hmo: { provider: 'Maxicare', member: 'MX-4481-2290', validUntil: '2027-06-30' },
    referral: 'Walk-in',
    medicalHistory: 'Hypertension. Enlarged prostate.',
    ophthalmicHistory: 'Family history of glaucoma (father). Cataract surgery OD in 2019.',
    reminders: ['SMS'],
    appointments: [{ daysFromNow: 4, hour: 10, status: 'SCHEDULED', reason: 'Intraocular pressure recheck', visitType: 'Follow-up' }],
    allergies: [{ allergen: 'Sulfa', reaction: 'Skin rash', severity: 'MODERATE' }],
    visits: [
      {
        daysAgo: 400, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Referred for high eye pressure',
        subjective: 'No symptoms. Pressure found high at an optical shop.',
        objective: 'IOP 28 OD, 26 OS. Cup-to-disc 0.7 both eyes. Angles open.',
        assessment: 'Primary open-angle glaucoma, both eyes.',
        plan: 'Start latanoprost both eyes at night. Visual field test. Recheck in 6 weeks.',
        diagnoses: [dx('H40.11', 'Primary open-angle glaucoma', 'OU')],
        findings: [['OD', 'IOP', '28', 'mmHg'], ['OS', 'IOP', '26', 'mmHg'], ['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen'], ['OD', 'OPTIC_DISC', 'C/D 0.7'], ['OS', 'OPTIC_DISC', 'C/D 0.7']],
        signed: true,
      },
      {
        daysAgo: 350, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Pressure check after starting drops',
        subjective: 'Using drops nightly. Mild redness.',
        objective: 'IOP 20 OD, 19 OS.',
        assessment: 'Good response to latanoprost.',
        plan: 'Continue. Recheck in 3 months.',
        diagnoses: [dx('H40.11', 'Primary open-angle glaucoma', 'OU')],
        findings: [['OD', 'IOP', '20', 'mmHg'], ['OS', 'IOP', '19', 'mmHg'], ['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen']],
        signed: true,
      },
      {
        daysAgo: 160, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: '3-month pressure check',
        subjective: 'Missed a few doses while travelling.',
        objective: 'IOP 24 OD, 22 OS. Disc unchanged.',
        assessment: 'Pressure above target after missed doses.',
        plan: 'Add timolol. Counsel on adherence. Recheck in 2 months.',
        diagnoses: [dx('H40.11', 'Primary open-angle glaucoma', 'OU')],
        findings: [['OD', 'IOP', '24', 'mmHg'], ['OS', 'IOP', '22', 'mmHg'], ['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen']],
        signed: true,
      },
      {
        daysAgo: 45, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Pressure recheck',
        subjective: 'Using both drops. No side effects.',
        objective: 'IOP 17 OD, 16 OS.',
        assessment: 'At target on two medicines.',
        plan: 'Continue. Visual field in 3 months. Return in 4 months.',
        diagnoses: [dx('H40.11', 'Primary open-angle glaucoma', 'OU')],
        findings: [['OD', 'IOP', '17', 'mmHg'], ['OS', 'IOP', '16', 'mmHg'], ['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen'], ['OD', 'OPTIC_DISC', 'C/D 0.7'], ['OS', 'OPTIC_DISC', 'C/D 0.7']],
        signed: true,
      },
    ],
    medications: [
      { name: 'Latanoprost', strength: '0.005%', dose: '1 drop', frequency: 'every night', route: 'ophthalmic', instructions: 'Both eyes at bedtime', indication: 'Glaucoma', startDaysAgo: 400 },
      { name: 'Timolol', strength: '0.5%', dose: '1 drop', frequency: 'twice a day', route: 'ophthalmic', instructions: 'Both eyes', indication: 'Glaucoma', startDaysAgo: 160 },
    ],
    followUps: [{ dueInDays: 75, taskType: 'CHECK_UP', reason: 'Pressure check and visual field test', priority: 'NORMAL', visit: 3 }],
  },

  // 3. Child with myopia, two visits, nothing scheduled, no labs, no follow-up.
  {
    key: 'dizon',
    clinic: 'tamesis',
    firstName: 'Angelo',
    lastName: 'Dizon',
    dateOfBirth: '2011-09-18',
    sex: 'MALE',
    occupation: 'Student',
    mobile: '09205550121',
    address: '7 Dapitan St., Sampaloc, Manila',
    emergencyName: 'Josefina Dizon (mother)',
    emergencyPhone: '09205550121',
    reminders: ['SMS', 'EMAIL'],
    email: 'dizon.family.demo@example.com',
    ophthalmicHistory: 'Glasses since age 9.',
    visits: [
      {
        daysAgo: 300, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Cannot read the board at school',
        subjective: 'Squints at the board. Many hours on a tablet.',
        objective: 'Uncorrected VA 20/100 both eyes. Improves to 20/20 with minus lenses.',
        assessment: 'Myopia, both eyes.',
        plan: 'Prescribe glasses. Limit screen time, outdoor play. Recheck in 6 months.',
        diagnoses: [dx('H52.1', 'Myopia', 'OU')],
        findings: [['OD', 'VA', '20/100', 'Snellen'], ['OS', 'VA', '20/100', 'Snellen'], ['OD', 'IOP', '13', 'mmHg'], ['OS', 'IOP', '13', 'mmHg']],
        signed: true,
      },
      {
        daysAgo: 60, type: 'FOLLOW_UP', booked: false,
        chiefComplaint: 'Check progress of nearsightedness',
        subjective: 'Glasses help. Slightly blurry again at distance.',
        objective: 'Uncorrected VA 20/200 both eyes. Corrects to 20/20 with stronger lenses.',
        assessment: 'Myopia progressing by about 0.75 D in a year.',
        plan: 'Update glasses. Discuss low-dose atropine at next visit.',
        diagnoses: [dx('H52.1', 'Myopia', 'OU')],
        findings: [['OD', 'VA', '20/200', 'Snellen'], ['OS', 'VA', '20/200', 'Snellen'], ['OD', 'IOP', '14', 'mmHg'], ['OS', 'IOP', '14', 'mmHg']],
        signed: true,
      },
    ],
  },

  // 4. Elderly cataract patient: no-show appointment, procedure follow-up due soon, HMO.
  {
    key: 'aquino',
    clinic: 'happy',
    firstName: 'Teresita',
    middleName: 'Gomez',
    lastName: 'Aquino',
    dateOfBirth: '1941-12-02',
    sex: 'FEMALE',
    civilStatus: 'Widowed',
    mobile: '09215550131',
    address: '33 Doña Soledad Ave., BF Homes, Parañaque',
    emergencyName: 'Marissa Aquino-Lopez (daughter)',
    emergencyPhone: '09215550132',
    hmo: { provider: 'Intellicare', member: 'IC-77120', validUntil: '2026-12-31' },
    philhealth: '09-876543210-5',
    medicalHistory: 'Osteoarthritis of both knees. Mild heart murmur, no treatment.',
    reminders: ['SMS'],
    visits: [
      {
        daysAgo: 90, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Hazy vision, glare when driven at night',
        subjective: 'Gradual over two years. Has stopped reading.',
        objective: 'VA 20/80 OD, 20/200 OS. Nuclear sclerosis 3+ both eyes.',
        assessment: 'Senile nuclear cataract, worse in the left eye.',
        plan: 'Surgery advised for the left eye first. Pre-op tests and clearance.',
        diagnoses: [dx('H25.1', 'Age-related nuclear cataract', 'OU')],
        findings: [['OD', 'VA', '20/80', 'Snellen'], ['OS', 'VA', '20/200', 'Snellen'], ['OD', 'LENS', 'NS 3+'], ['OS', 'LENS', 'NS 3+ with posterior subcapsular changes'], ['OD', 'IOP', '14', 'mmHg'], ['OS', 'IOP', '15', 'mmHg']],
        signed: true,
      },
      {
        daysAgo: 14, type: 'PROCEDURE', booked: true,
        chiefComplaint: 'Left eye cataract surgery',
        subjective: 'Cleared by her physician.',
        objective: 'Phacoemulsification with IOL, left eye. Uneventful.',
        assessment: 'Pseudophakia, left eye, day 0.',
        plan: 'Antibiotic-steroid drops. Review day 1, week 1, month 1.',
        diagnoses: [dx('Z96.1', 'Presence of intraocular lens', 'OS')],
        findings: [['OS', 'VA', 'CF', undefined], ['OS', 'CORNEA', 'Clear, incision sealed']],
        signed: true,
      },
    ],
    medications: [
      { name: 'Moxifloxacin', strength: '0.5%', dose: '1 drop', frequency: '4 times a day', route: 'ophthalmic', instructions: 'Left eye, for 1 week', indication: 'After cataract surgery', startDaysAgo: 14, endDaysAgo: 7, status: 'DISCONTINUED' },
      { name: 'Prednisolone', strength: '1%', dose: '1 drop', frequency: 'twice a day', route: 'ophthalmic', instructions: 'Left eye, taper over 4 weeks', indication: 'After cataract surgery', startDaysAgo: 14 },
    ],
    appointments: [{ daysFromNow: -3, hour: 15, status: 'NO_SHOW', reason: 'One-week post-op check', visitType: 'Post-op' }],
    followUps: [
      { dueInDays: 5, taskType: 'PROCEDURE', reason: 'One-month post-op visit; plan right eye cataract date', priority: 'HIGH', visit: 1 },
      { dueInDays: -3, taskType: 'FOLLOW_UP', reason: 'Missed the one-week post-op check, call to rebook', priority: 'HIGH', status: 'UNREACHABLE', closureNote: 'Three calls, no answer. Daughter to be reached.' },
    ],
  },

  // 5. Allergy alert case: severe penicillin allergy and a cephalosporin prescribed.
  {
    key: 'bautista',
    clinic: 'tamesis',
    firstName: 'Jose Miguel',
    lastName: 'Bautista',
    dateOfBirth: '1978-02-26',
    sex: 'MALE',
    civilStatus: 'Married',
    occupation: 'Jeepney operator',
    mobile: '09225550141',
    email: 'jm.bautista.demo@example.com',
    address: '210 Lacson Ave., Sampaloc, Manila',
    medicalHistory: 'Allergic rhinitis.',
    reminders: ['EMAIL'],
    appointments: [{ daysFromNow: 3, hour: 14, status: 'CONFIRMED', reason: 'Eyelid recheck after treatment', visitType: 'Follow-up' }],
    allergies: [
      { allergen: 'Penicillin', reaction: 'Anaphylaxis (2009)', severity: 'SEVERE' },
      { allergen: 'Sulfa', reaction: 'Hives', severity: 'MILD' },
    ],
    visits: [
      {
        daysAgo: 35, type: 'NEW_PATIENT', booked: false,
        chiefComplaint: 'Painful swelling of the right upper lid for 4 days',
        subjective: 'Tender lump. No fever. Wears contact lenses occasionally.',
        objective: 'Tender erythematous nodule on the right upper lid margin. VA 20/20 both eyes.',
        assessment: 'External hordeolum, right upper lid.',
        plan: 'Warm compresses. Oral cephalexin after allergy review. Recheck in 1 week.',
        diagnoses: [dx('H00.011', 'Hordeolum externum right upper eyelid', 'OD')],
        findings: [['OD', 'VA', '20/20', 'Snellen'], ['OS', 'VA', '20/20', 'Snellen'], ['OD', 'LIDS_LASHES', 'Tender nodule, upper lid margin'], ['OS', 'LIDS_LASHES', 'Normal']],
        signed: true,
      },
      {
        daysAgo: 28, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'One-week recheck of the right upper lid swelling',
        subjective: 'Lump much smaller, no pain. Last day of the antibiotic, with no rash or breathing trouble.',
        objective: 'Small residual nodule on the right upper lid margin, no redness. VA 20/20 both eyes.',
        assessment: 'Hordeolum, right upper lid, resolving.',
        plan: 'Continue warm compresses for a week. Lid hygiene. Return if it grows back.',
        diagnoses: [dx('H00.011', 'Hordeolum externum right upper eyelid', 'OD')],
        findings: [['OD', 'VA', '20/20', 'Snellen'], ['OS', 'VA', '20/20', 'Snellen'], ['OD', 'LIDS_LASHES', 'Small residual nodule, no inflammation']],
        signed: true,
      },
    ],
    medications: [
      {
        name: 'Cephalexin', strength: '500 mg', dose: '1 capsule', frequency: '4 times a day', route: 'oral',
        instructions: 'For 7 days', indication: 'Hordeolum', startDaysAgo: 35, endDaysAgo: 28, status: 'DISCONTINUED',
        ackReason: 'Patient reports tolerating cephalexin before without reaction. First dose given in clinic and observed for 30 minutes.',
      },
    ],
    images: [{ kind: 'external', caption: 'Right upper lid hordeolum before treatment', visit: 0 }],
  },

  // 6. Young adult, dry eye. Today's visit is still a DRAFT, appointment today.
  {
    key: 'ocampo',
    clinic: 'uerm',
    firstName: 'Liza Mae',
    lastName: 'Ocampo',
    dateOfBirth: '1995-06-11',
    sex: 'FEMALE',
    civilStatus: 'Single',
    occupation: 'Call center agent',
    mobile: '09235550151',
    email: 'liza.ocampo.demo@example.com',
    address: 'Unit 8B Tower 2, Cubao, Quezon City',
    referral: 'Facebook page',
    reminders: ['SMS', 'EMAIL'],
    appointments: [{ daysFromNow: 6, hour: 13, status: 'SCHEDULED', reason: 'Dry eye review', visitType: 'Follow-up' }],
    visits: [
      {
        daysAgo: 70, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Dry, burning eyes at the end of the shift',
        subjective: 'Wears soft contact lenses 12 hours daily. Night shift, 9 hours on screen.',
        objective: 'VA 20/20 both eyes. Tear break-up time 4 seconds. Mild punctate staining.',
        assessment: 'Dry eye disease, both eyes, related to lens wear and screens.',
        plan: 'Preservative-free tears, lid hygiene, rest from lenses. Recheck in 2 months.',
        diagnoses: [dx('H04.123', 'Dry eye syndrome of bilateral lacrimal glands', 'OU')],
        findings: [['OD', 'VA', '20/20', 'Snellen'], ['OS', 'VA', '20/20', 'Snellen'], ['OD', 'CORNEA', 'Mild punctate staining'], ['OS', 'CORNEA', 'Mild punctate staining']],
        signed: true,
      },
      {
        daysAgo: 0, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Dry eye recheck',
        subjective: 'Better with drops. Still uncomfortable after 6 hours of lens wear.',
        objective: 'VA 20/20 both eyes.',
        assessment: '',
        plan: '',
        diagnoses: [],
        findings: [['OD', 'VA', '20/20', 'Snellen'], ['OS', 'VA', '20/20', 'Snellen']],
        signed: false,
      },
    ],
    medications: [
      { name: 'Artificial tears', strength: 'preservative-free', dose: '1 drop', frequency: '4 times a day', route: 'ophthalmic', instructions: 'Both eyes', indication: 'Dry eye', startDaysAgo: 70 },
    ],
    followUps: [{ dueInDays: 14, taskType: 'FOLLOW_UP', reason: 'Re-check after dry eye regimen', priority: 'LOW', visit: 1 }],
  },

  // 7. Diabetic macular edema: injection due today, labs, OCT images.
  {
    key: 'ramos',
    clinic: 'tamesis',
    firstName: 'Ernesto',
    middleName: 'Pascual',
    lastName: 'Ramos',
    dateOfBirth: '1969-10-30',
    sex: 'MALE',
    civilStatus: 'Married',
    occupation: 'Taxi driver',
    mobile: '09245550161',
    address: '15 Pedro Gil St., Paco, Manila',
    emergencyName: 'Luzviminda Ramos',
    emergencyPhone: '09245550162',
    philhealth: '11-222333444-5',
    medicalHistory: 'Type 2 diabetes for 15 years on insulin. Chronic kidney disease stage 2.',
    reminders: ['SMS'],
    visits: [
      {
        daysAgo: 180, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Distorted central vision, left eye',
        subjective: 'Two months. Difficulty reading signs while driving.',
        objective: 'VA 20/30 OD, 20/80 OS. OCT: central thickness raised OS.',
        assessment: 'Diabetic macular edema, left eye. Moderate NPDR right eye.',
        plan: 'Intravitreal anti-VEGF series in the left eye, monthly.',
        diagnoses: [dx('E11.311', 'Type 2 diabetes with unspecified diabetic retinopathy with macular edema', 'OS')],
        findings: [['OD', 'VA', '20/30', 'Snellen'], ['OS', 'VA', '20/80', 'Snellen'], ['OD', 'IOP', '16', 'mmHg'], ['OS', 'IOP', '17', 'mmHg'], ['OS', 'MACULA', 'Cystoid edema, hard exudates']],
        signed: true,
      },
      {
        daysAgo: 100, type: 'PROCEDURE', booked: true,
        chiefComplaint: 'Intravitreal injection #2',
        subjective: 'Vision a little better after the first injection.',
        objective: 'VA 20/60 OS. Injection performed without complication.',
        assessment: 'DME improving, left eye.',
        plan: 'Third injection in 4 weeks.',
        diagnoses: [dx('E11.311', 'Type 2 diabetes with unspecified diabetic retinopathy with macular edema', 'OS')],
        findings: [['OD', 'VA', '20/30', 'Snellen'], ['OS', 'VA', '20/60', 'Snellen'], ['OS', 'IOP', '18', 'mmHg'], ['OS', 'MACULA', 'Less edema']],
        signed: true,
      },
      {
        daysAgo: 28, type: 'PROCEDURE', booked: true,
        chiefComplaint: 'Intravitreal injection #3',
        subjective: 'Reading is easier.',
        objective: 'VA 20/50 OS. Injection performed without complication.',
        assessment: 'DME responding, left eye.',
        plan: 'Maintenance injection in 4 weeks. HbA1c and creatinine request.',
        diagnoses: [dx('E11.311', 'Type 2 diabetes with unspecified diabetic retinopathy with macular edema', 'OS')],
        findings: [['OD', 'VA', '20/30', 'Snellen'], ['OS', 'VA', '20/50', 'Snellen'], ['OS', 'IOP', '17', 'mmHg'], ['OS', 'MACULA', 'Minimal edema']],
        signed: true,
      },
    ],
    labs: [
      { daysAgo: 185, test: 'HbA1c', value: '9.2', unit: '%', range: '<5.7', lab: 'St. Luke\'s Laboratory', visit: 0 },
      { daysAgo: 105, test: 'HbA1c', value: '8.5', unit: '%', range: '<5.7', lab: 'St. Luke\'s Laboratory', visit: 1 },
      { daysAgo: 30, test: 'HbA1c', value: '7.8', unit: '%', range: '<5.7', lab: 'St. Luke\'s Laboratory', visit: 2 },
      { daysAgo: 185, test: 'Creatinine', value: '1.3', unit: 'mg/dL', range: '0.6-1.2', lab: 'St. Luke\'s Laboratory', visit: 0 },
      { daysAgo: 30, test: 'Creatinine', value: '1.4', unit: 'mg/dL', range: '0.6-1.2', lab: 'St. Luke\'s Laboratory', visit: 2 },
      { daysAgo: 30, test: 'Total cholesterol', value: '214', unit: 'mg/dL', range: '<200', lab: 'St. Luke\'s Laboratory' },
    ],
    followUps: [
      { dueInDays: 0, taskType: 'INJECTION', reason: 'Maintenance anti-VEGF injection, left eye', priority: 'HIGH', visit: 2 },
      { dueInDays: 21, taskType: 'LAB_TEST', reason: 'HbA1c and creatinine before next injection', priority: 'NORMAL', visit: 2 },
    ],
    appointments: [{ daysFromNow: 1, hour: 14, status: 'SCHEDULED', reason: 'Intravitreal injection', visitType: 'Procedure' }],
    images: [
      { kind: 'oct', caption: 'Macular OCT, left eye, before treatment', visit: 0 },
      { kind: 'oct', caption: 'Macular OCT, left eye, after 3 injections', visit: 2 },
    ],
  },

  // 8. Hypertensive retinopathy at Happy Eyes: BP and lipid labs, an addendum, no images.
  {
    key: 'reyes',
    clinic: 'happy',
    firstName: 'Carmelita',
    lastName: 'Reyes',
    dateOfBirth: '1957-01-19',
    sex: 'FEMALE',
    civilStatus: 'Married',
    occupation: 'Market vendor',
    mobile: '09255550171',
    address: '5 Aguirre Ave., BF Homes, Parañaque',
    emergencyName: 'Danilo Reyes',
    emergencyPhone: '09255550172',
    medicalHistory: 'Hypertension for 20 years, irregular medicine intake. High cholesterol.',
    reminders: [],
    visits: [
      {
        daysAgo: 210, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Floaters and dim vision',
        subjective: 'Headaches in the morning. Stopped her BP medicine two weeks ago.',
        objective: 'BP 170/100 in clinic. VA 20/30 both eyes. Arteriolar narrowing and A-V nicking both eyes.',
        assessment: 'Hypertensive retinopathy grade 2, both eyes.',
        plan: 'Refer to her physician for BP control. Recheck in 3 months.',
        diagnoses: [dx('H35.03', 'Hypertensive retinopathy', 'OU')],
        findings: [['OD', 'VA', '20/30', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen'], ['OD', 'IOP', '17', 'mmHg'], ['OS', 'IOP', '18', 'mmHg'], ['OD', 'OPTIC_DISC', 'Margins sharp'], ['OS', 'OPTIC_DISC', 'Margins sharp']],
        signed: true,
      },
      {
        daysAgo: 95, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Recheck after seeing her physician',
        subjective: 'Taking amlodipine daily.',
        objective: 'BP 140/90. VA 20/25 both eyes. Retinal changes less marked.',
        assessment: 'Hypertensive retinopathy improving with control.',
        plan: 'Continue BP control. Lipid test. Return in 3 months.',
        diagnoses: [dx('H35.03', 'Hypertensive retinopathy', 'OU')],
        findings: [['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/25', 'Snellen'], ['OD', 'IOP', '16', 'mmHg'], ['OS', 'IOP', '17', 'mmHg']],
        signed: true,
        addendum: { reason: 'Correction to the plan', text: 'Next visit is in 3 months, not 6 as written. Patient informed by phone.' },
      },
    ],
    labs: [
      { daysAgo: 214, test: 'Blood pressure (systolic)', value: '170', unit: 'mmHg', range: '<130', lab: 'Clinic reading', visit: 0 },
      { daysAgo: 98, test: 'Blood pressure (systolic)', value: '140', unit: 'mmHg', range: '<130', lab: 'Clinic reading', visit: 1 },
      { daysAgo: 20, test: 'Blood pressure (systolic)', value: '128', unit: 'mmHg', range: '<130', lab: 'Barangay health center' },
      { daysAgo: 98, test: 'Total cholesterol', value: '248', unit: 'mg/dL', range: '<200', lab: 'Hi-Precision Diagnostics', visit: 1 },
      { daysAgo: 98, test: 'LDL cholesterol', value: '162', unit: 'mg/dL', range: '<100', lab: 'Hi-Precision Diagnostics', visit: 1 },
    ],
    medications: [{ name: 'Amlodipine', strength: '5 mg', dose: '1 tablet', frequency: 'once a day', route: 'oral', indication: 'Hypertension', startDaysAgo: 120, source: 'OTHER_DOCTOR' }],
    followUps: [{ dueInDays: -20, taskType: 'CHECK_UP', reason: 'Three-month retina and blood pressure review', priority: 'NORMAL', visit: 1 }],
  },

  // 9. Keratoconus: three visits, topography images, completed follow-up, no medicines.
  {
    key: 'yamamoto',
    clinic: 'uerm',
    firstName: 'Kenji',
    middleName: 'Santos',
    lastName: 'Yamamoto',
    dateOfBirth: '1988-04-08',
    sex: 'MALE',
    civilStatus: 'Single',
    occupation: 'Graphic designer',
    mobile: '09265550181',
    email: 'kenji.yamamoto.demo@example.com',
    address: '90 Scout Tuason St., Quezon City',
    referral: 'Optometrist',
    ophthalmicHistory: 'Frequent changes in glasses. Eye rubbing.',
    reminders: ['EMAIL'],
    appointments: [{ daysFromNow: 10, hour: 14, status: 'SCHEDULED', reason: 'Contact lens fitting review', visitType: 'Follow-up' }],
    visits: [
      {
        daysAgo: 330, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Glasses keep changing, ghosting of images',
        subjective: 'Ghost images in the right eye. Rubs eyes often.',
        objective: 'VA 20/60 OD, 20/30 OS. Corneal topography shows inferior steepening OD.',
        assessment: 'Keratoconus, right eye, early left eye.',
        plan: 'Stop eye rubbing. Corneal cross-linking evaluation. Recheck in 6 months.',
        diagnoses: [dx('H18.62', 'Keratoconus, unstable', 'OD'), dx('H18.61', 'Keratoconus, stable', 'OS')],
        findings: [['OD', 'VA', '20/60', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen'], ['OD', 'CORNEA', 'Inferior steepening, Fleischer ring'], ['OS', 'CORNEA', 'Mild inferior steepening']],
        signed: true,
      },
      {
        daysAgo: 150, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Six-month review',
        subjective: 'Vision worse in the right eye.',
        objective: 'VA 20/80 OD, 20/30 OS. Progression on topography OD.',
        assessment: 'Progressive keratoconus, right eye.',
        plan: 'Cross-linking right eye advised.',
        diagnoses: [dx('H18.62', 'Keratoconus, unstable', 'OD')],
        findings: [['OD', 'VA', '20/80', 'Snellen'], ['OS', 'VA', '20/30', 'Snellen'], ['OD', 'CORNEA', 'Progressive steepening']],
        signed: true,
      },
      {
        daysAgo: 40, type: 'PROCEDURE', booked: true,
        chiefComplaint: 'Corneal cross-linking, right eye',
        subjective: 'Understood the risks and benefits.',
        objective: 'Epithelium-off cross-linking performed. Uneventful.',
        assessment: 'Post cross-linking day 0.',
        plan: 'Bandage lens, antibiotic and steroid drops, review day 1 and week 1.',
        diagnoses: [dx('H18.62', 'Keratoconus, unstable', 'OD')],
        findings: [['OD', 'CORNEA', 'Epithelial defect, haze minimal']],
        signed: true,
      },
    ],
    followUps: [
      { dueInDays: -33, taskType: 'FOLLOW_UP', reason: 'One-week post cross-linking check', priority: 'HIGH', status: 'COMPLETED', closureNote: 'Seen and healing well.', visit: 2 },
      { dueInDays: 50, taskType: 'CHECK_UP', reason: 'Three-month topography after cross-linking', priority: 'NORMAL', visit: 2 },
    ],
    images: [
      { kind: 'topography', caption: 'Corneal topography, right eye, before cross-linking', visit: 1 },
      { kind: 'slit', caption: 'Slit lamp, right eye, one week after cross-linking', visit: 2 },
    ],
  },

  // 10. Young child with amblyopia, two visits, appointment upcoming, parent contact.
  {
    key: 'mendoza',
    clinic: 'happy',
    firstName: 'Princess Joy',
    lastName: 'Mendoza',
    dateOfBirth: '2018-05-23',
    sex: 'FEMALE',
    mobile: '09275550191',
    email: 'mendoza.mom.demo@example.com',
    address: '14 Sampaguita St., Moonwalk, Parañaque',
    emergencyName: 'Grace Mendoza (mother)',
    emergencyPhone: '09275550191',
    referral: 'Pediatrician',
    reminders: ['SMS', 'EMAIL'],
    visits: [
      {
        daysAgo: 150, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Failed vision screening at school',
        subjective: 'Mother noticed she tilts her head. Born at 36 weeks.',
        objective: 'VA 20/25 OD, 20/80 OS. Hyperopia +4.00 D OS. No strabismus.',
        assessment: 'Anisometropic amblyopia, left eye.',
        plan: 'Glasses full time. Patch the right eye 2 hours daily. Recheck in 2 months.',
        diagnoses: [dx('H53.032', 'Anisometropic amblyopia, left eye', 'OS')],
        findings: [['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/80', 'Snellen']],
        signed: true,
      },
      {
        daysAgo: 55, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Patching progress',
        subjective: 'Wears glasses. Patching most days.',
        objective: 'VA 20/25 OD, 20/50 OS.',
        assessment: 'Amblyopia improving.',
        plan: 'Continue patching. Recheck in 2 months.',
        diagnoses: [dx('H53.032', 'Anisometropic amblyopia, left eye', 'OS')],
        findings: [['OD', 'VA', '20/25', 'Snellen'], ['OS', 'VA', '20/50', 'Snellen']],
        signed: true,
      },
    ],
    appointments: [{ daysFromNow: 8, hour: 14, status: 'SCHEDULED', reason: 'Amblyopia follow-up', visitType: 'Follow-up' }],
    followUps: [{ dueInDays: 8, taskType: 'CHECK_UP', reason: 'Visual acuity and patching review', priority: 'NORMAL', visit: 1 }],
  },

  // 11. Elderly AMD with an NSAID allergy and a bromfenac drop: second alert case; overdue, declined follow-up.
  {
    key: 'garcia',
    clinic: 'happy',
    firstName: 'Rodolfo',
    lastName: 'Garcia',
    dateOfBirth: '1946-08-15',
    sex: 'MALE',
    civilStatus: 'Married',
    occupation: 'Retired seaman',
    mobile: '09285550201',
    address: '27 Quirino Ave., Tambo, Parañaque',
    emergencyName: 'Estrella Garcia',
    emergencyPhone: '09285550202',
    hmo: { provider: 'PhilCare', member: 'PC-90871', validUntil: '2026-03-31' },
    medicalHistory: 'Atrial fibrillation on blood thinners. Gout.',
    ophthalmicHistory: 'Smoker for 40 years.',
    reminders: ['SMS'],
    withdrawnReminder: true,
    allergies: [{ allergen: 'Ibuprofen', reaction: 'Stomach bleeding, wheezing', severity: 'MODERATE' }],
    visits: [
      {
        daysAgo: 130, type: 'NEW_PATIENT', booked: true,
        chiefComplaint: 'Straight lines look wavy',
        subjective: 'Two months. Cannot read with the left eye.',
        objective: 'VA 20/40 OD, 20/200 OS. Drusen both eyes, subretinal hemorrhage OS.',
        assessment: 'Wet age-related macular degeneration, left eye. Dry AMD right eye.',
        plan: 'Anti-VEGF injections, left eye. Amsler grid at home.',
        diagnoses: [dx('H35.32', 'Exudative age-related macular degeneration', 'OS'), dx('H35.31', 'Nonexudative age-related macular degeneration', 'OD')],
        findings: [['OD', 'VA', '20/40', 'Snellen'], ['OS', 'VA', '20/200', 'Snellen'], ['OD', 'MACULA', 'Drusen'], ['OS', 'MACULA', 'Subretinal hemorrhage']],
        signed: true,
      },
      {
        daysAgo: 100, type: 'PROCEDURE', booked: true,
        chiefComplaint: 'First injection, left eye',
        subjective: 'Worried about the injection.',
        objective: 'Intravitreal injection performed. VA 20/200 OS.',
        assessment: 'Wet AMD, injection 1 of 3.',
        plan: 'Repeat monthly for 3 months.',
        diagnoses: [dx('H35.32', 'Exudative age-related macular degeneration', 'OS')],
        findings: [['OS', 'VA', '20/200', 'Snellen'], ['OS', 'IOP', '18', 'mmHg']],
        signed: true,
      },
      {
        daysAgo: 75, type: 'PROCEDURE', booked: true,
        chiefComplaint: 'Second injection, left eye',
        subjective: 'Slightly better.',
        objective: 'VA 20/160 OS. Injection performed.',
        assessment: 'Wet AMD responding.',
        plan: 'Third injection next month. Family declined further visits for now.',
        diagnoses: [dx('H35.32', 'Exudative age-related macular degeneration', 'OS')],
        findings: [['OS', 'VA', '20/160', 'Snellen'], ['OS', 'IOP', '17', 'mmHg']],
        signed: true,
      },
    ],
    medications: [
      {
        name: 'Bromfenac', strength: '0.09%', dose: '1 drop', frequency: 'once a day', route: 'ophthalmic',
        instructions: 'Left eye, after injection', indication: 'Inflammation after injection', startDaysAgo: 75, endDaysAgo: 60, status: 'DISCONTINUED',
        ackReason: 'Topical only with negligible absorption. Short course, patient advised to stop if wheezing.',
      },
    ],
    followUps: [
      { dueInDays: -45, taskType: 'INJECTION', reason: 'Third anti-VEGF injection, left eye', priority: 'HIGH', status: 'DECLINED', closureNote: 'Family prefers to wait; will call.', visit: 2 },
      { dueInDays: -30, taskType: 'CHECK_UP', reason: 'Check vision and Amsler grid findings', priority: 'HIGH', visit: 2 },
    ],
    images: [
      { kind: 'oct', caption: 'Macular OCT, left eye, subretinal fluid', visit: 0 },
      { kind: 'fundus', caption: 'Fundus, left eye, hemorrhage at the macula', visit: 0 },
    ],
  },

  // 12. Uveitis: a steroid taper recorded as dose changes, three visits, one cancelled and one upcoming appointment.
  {
    key: 'lim',
    clinic: 'uerm',
    firstName: 'Bernadette',
    middleName: 'Tan',
    lastName: 'Lim',
    dateOfBirth: '1983-11-05',
    sex: 'FEMALE',
    civilStatus: 'Married',
    occupation: 'Accountant',
    mobile: '09295550211',
    email: 'bernadette.lim.demo@example.com',
    address: '61 Maginhawa St., Teachers Village, Quezon City',
    emergencyName: 'Kevin Lim',
    emergencyPhone: '09295550212',
    hmo: { provider: 'Medicard', member: 'MC-5530911', validUntil: '2027-01-31' },
    medicalHistory: 'Ankylosing spondylitis, on regular rheumatology follow-up.',
    reminders: ['SMS', 'EMAIL'],
    visits: [
      {
        daysAgo: 85, type: 'WALK_IN', booked: false,
        chiefComplaint: 'Red, painful left eye with light sensitivity since yesterday',
        subjective: 'Third episode. Blurry. Took paracetamol with no help.',
        objective: 'VA 20/20 OD, 20/50 OS. Ciliary flush, 2+ cells and flare OS. IOP 11 OS.',
        assessment: 'Acute anterior uveitis, left eye, probably HLA-B27 related.',
        plan: 'Prednisolone drops hourly then taper, cycloplegic drop at night. Recheck in 3 days.',
        diagnoses: [dx('H20.02', 'Acute and subacute iridocyclitis, recurrent', 'OS')],
        findings: [['OD', 'VA', '20/20', 'Snellen'], ['OS', 'VA', '20/50', 'Snellen'], ['OD', 'IOP', '14', 'mmHg'], ['OS', 'IOP', '11', 'mmHg'], ['OS', 'CORNEA', 'Fine keratic precipitates']],
        signed: true,
      },
      {
        daysAgo: 80, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Three-day recheck',
        subjective: 'Much less pain.',
        objective: 'VA 20/25 OS. 1+ cells. IOP 13.',
        assessment: 'Uveitis improving on steroid drops.',
        plan: 'Reduce prednisolone to 4 times a day. Recheck in 2 weeks.',
        diagnoses: [dx('H20.02', 'Acute and subacute iridocyclitis, recurrent', 'OS')],
        findings: [['OS', 'VA', '20/25', 'Snellen'], ['OS', 'IOP', '13', 'mmHg']],
        signed: true,
      },
      {
        daysAgo: 30, type: 'FOLLOW_UP', booked: true,
        chiefComplaint: 'Taper review',
        subjective: 'Eye comfortable. Using drops twice a day.',
        objective: 'VA 20/20 OS. Quiet anterior chamber. IOP 15.',
        assessment: 'Uveitis resolved. No steroid-induced pressure rise.',
        plan: 'Stop drops after one more week. Return if the eye turns red.',
        diagnoses: [dx('H20.02', 'Acute and subacute iridocyclitis, recurrent', 'OS')],
        findings: [['OS', 'VA', '20/20', 'Snellen'], ['OD', 'IOP', '14', 'mmHg'], ['OS', 'IOP', '15', 'mmHg']],
        signed: true,
        addendum: { reason: 'Result discussed with rheumatologist', text: 'Spoke with Dr. Chua (rheumatology). Will review biologic therapy given three episodes in one year.' },
      },
    ],
    medications: [
      { name: 'Prednisolone', strength: '1%', dose: '1 drop', frequency: 'every hour while awake', route: 'ophthalmic', instructions: 'Left eye', indication: 'Anterior uveitis', startDaysAgo: 85, endDaysAgo: 80, status: 'DISCONTINUED' },
      { name: 'Prednisolone', strength: '1%', dose: '1 drop', frequency: '4 times a day', route: 'ophthalmic', instructions: 'Left eye', indication: 'Anterior uveitis', startDaysAgo: 80, endDaysAgo: 30, status: 'DISCONTINUED', replaces: 0 },
      { name: 'Prednisolone', strength: '1%', dose: '1 drop', frequency: 'twice a day', route: 'ophthalmic', instructions: 'Left eye, then stop', indication: 'Anterior uveitis', startDaysAgo: 30, endDaysAgo: 23, status: 'DISCONTINUED', replaces: 1 },
    ],
    appointments: [
      { daysFromNow: -6, hour: 14, status: 'CANCELLED', reason: 'Routine check', visitType: 'Follow-up', cancelReason: 'Patient called, conflict with work' },
      { daysFromNow: 5, hour: 14, status: 'CONFIRMED', reason: 'Steroid taper check', visitType: 'Follow-up' },
      { daysFromNow: 20, hour: 13, status: 'SCHEDULED', reason: 'Three-month uveitis review', visitType: 'Follow-up' },
    ],
  },

  // 13. A walk-in with a quick recheck, no appointment, no consent to reminders, no follow-up.
  {
    key: 'torres',
    clinic: 'happy',
    firstName: 'Samuel',
    lastName: 'Torres',
    dateOfBirth: '2001-02-14',
    sex: 'MALE',
    occupation: 'Construction worker',
    mobile: '09305550221',
    address: '3 Evacom Rd., San Dionisio, Parañaque',
    reminders: [],
    visits: [
      {
        daysAgo: 9, type: 'WALK_IN', booked: false,
        chiefComplaint: 'Something got in the right eye at work, painful and tearing',
        subjective: 'Metal dust while grinding without goggles. Onset 3 hours ago.',
        objective: 'VA 20/40 OD, 20/20 OS. Small corneal abrasion at 4 o\'clock, no foreign body.',
        assessment: 'Corneal abrasion, right eye.',
        plan: 'Antibiotic ointment, no patching. Wear goggles. Return in 2 days or sooner if worse.',
        diagnoses: [dx('S05.01', 'Injury of conjunctiva and corneal abrasion without foreign body', 'OD')],
        findings: [['OD', 'VA', '20/40', 'Snellen'], ['OS', 'VA', '20/20', 'Snellen'], ['OD', 'CORNEA', 'Abrasion 1.5 mm, 4 o\'clock']],
        signed: true,
      },
      {
        daysAgo: 7, type: 'FOLLOW_UP', booked: false,
        chiefComplaint: 'Recheck of the right corneal abrasion',
        subjective: 'Pain and tearing gone after two days. Using the ointment as told. Wearing goggles now.',
        objective: 'VA 20/20 both eyes. Fluorescein stain negative, cornea clear.',
        assessment: 'Corneal abrasion, right eye, healed.',
        plan: 'Stop ointment after the 5-day course. Wear safety goggles at work. Return if symptoms come back.',
        diagnoses: [dx('S05.01', 'Injury of conjunctiva and corneal abrasion without foreign body', 'OD')],
        findings: [['OD', 'VA', '20/20', 'Snellen'], ['OS', 'VA', '20/20', 'Snellen'], ['OD', 'CORNEA', 'Healed, stain negative']],
        signed: true,
      },
    ],
    medications: [
      { name: 'Ofloxacin', strength: '0.3%', dose: '1 drop', frequency: '4 times a day', route: 'ophthalmic', instructions: 'Right eye for 5 days', indication: 'Corneal abrasion', startDaysAgo: 9, endDaysAgo: 4, status: 'DISCONTINUED' },
    ],
    images: [{ kind: 'slit', caption: 'Fluorescein stain, right cornea', visit: 0 }],
  },
];

// ============================================================================
// 2. Sample images (drawn from maths, no real scans)
// ============================================================================

/**
 * Tiny synthetic PNGs for the demo. They are drawn from maths, not from real
 * patients or real scans, so they are safe to ship and carry no personal data.
 * No image library: a PNG is a signature, an IHDR, zlib-compressed rows and an IEND.
 */
export type ImageKind = 'fundus' | 'oct' | 'slit' | 'topography' | 'external';

const W = 640;
const H = 480;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

type Rgb = [number, number, number];
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Deterministic pseudo-noise so every run produces the same picture. */
function noise(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function pixel(kind: ImageKind, x: number, y: number): Rgb {
  const cx = W / 2;
  const cy = H / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  const n = noise(x, y) * 10;

  switch (kind) {
    case 'fundus': {
      const R = 220;
      if (r > R) return [8, 6, 6];
      const glow = 1 - (r / R) * 0.45;
      let c: Rgb = [210 * glow, 85 * glow, 40 * glow];
      // Optic disc, nasal side.
      const disc = Math.hypot(x - (cx + 95), y - (cy - 10));
      if (disc < 34) c = [250, 215 - disc, 120];
      // Vessels radiating from the disc.
      const ang = Math.atan2(y - (cy - 10), x - (cx + 95));
      const vessel = Math.abs(Math.sin(ang * 6 + disc * 0.02));
      if (disc > 30 && vessel < 0.07 && disc < 300) c = [110, 20, 18];
      // A few hemorrhage dots.
      if (Math.hypot(x - (cx - 40), y - (cy + 30)) < 6 || Math.hypot(x - (cx - 80), y - (cy - 20)) < 5) c = [120, 10, 10];
      return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n)];
    }
    case 'oct': {
      // Layered retina with a foveal dip.
      const dip = 38 * Math.exp(-(dx * dx) / 9000);
      const top = 150 + dip + 8 * Math.sin(x / 40);
      const band = y - top;
      let v = 12;
      if (band > 0 && band < 130) {
        const layer = Math.sin(band / 5.5);
        v = 70 + 90 * Math.max(0, layer);
        if (band > 112) v = 210; // RPE line
      }
      return [clamp(v + n), clamp(v + n), clamp(v + n)];
    }
    case 'slit': {
      const beam = Math.abs(dx - 40 - dy * 0.25);
      const lens = r < 200 ? 30 : 6;
      const b = beam < 22 ? 230 - beam * 6 : lens;
      return [clamp(b * 0.9 + n), clamp(b * 0.95 + n), clamp(b + 20 + n)];
    }
    case 'topography': {
      // Concentric colour rings with an off-centre steep area (cone).
      const cone = Math.hypot(x - (cx + 20), y - (cy + 55));
      const v = Math.min(r, 230) / 230;
      const hot = Math.exp(-(cone * cone) / 5000);
      const t = Math.min(1, v * 0.6 + hot * 0.8);
      const ring = (Math.sin(r / 7) + 1) / 2;
      if (r > 235) return [20, 20, 24];
      return [clamp(255 * t + ring * 12), clamp(200 * (1 - Math.abs(t - 0.5) * 2) + ring * 12), clamp(255 * (1 - t) + ring * 12)];
    }
    case 'external': {
      // Skin tone, an eye shape, an iris and a swollen lid margin.
      const eye = (dx * dx) / (190 * 190) + (dy * dy) / (70 * 70);
      let c: Rgb = [214, 168, 138];
      if (eye < 1) c = [238, 232, 228];
      if (Math.hypot(dx, dy) < 58 && eye < 1) c = [74, 52, 38];
      if (Math.hypot(dx, dy) < 22 && eye < 1) c = [10, 8, 8];
      if (Math.abs(eye - 1) < 0.08) c = [170, 90, 80];
      if (Math.hypot(x - (cx + 90), y - (cy - 78)) < 18) c = [200, 90, 80];
      return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n)];
    }
  }
}

export function samplePng(kind: ImageKind): Buffer {
  const rows = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    rows[o++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixel(kind, x, y);
      rows[o++] = r;
      rows[o++] = g;
      rows[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ============================================================================
// 3. The seed
// ============================================================================

/**
 * Loads Dr. Pacio's three clinics and the sample patients with visits, signed
 * notes, lab results, images, medications, follow-ups and appointments, so every
 * screen has something to show.
 *
 * It creates no user accounts (see the header of this file). It writes through
 * the same encryption, hashing and locking rules as the API (encrypted fields,
 * signature hashes, database triggers).
 *
 * Signed notes and lab results cannot be changed or deleted, by design. So this
 * is run once on a fresh database; to start over, rebuild the database
 * (scripts/rebuild-demo-db.sh) instead of trying to re-run it.
 */
const CLINICS: Record<ClinicKey, { id: string; name: string; address: string; phone: string; hours: Array<{ dayOfWeek: number; openTime: string; closeTime: string }> }> = {
  uerm: {
    id: 'seed-clinic-uerm',
    name: 'UERM',
    address: 'Rm 302, Aurora Blvd, Quezon City',
    phone: '(02) 8555-0100',
    hours: [
      { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
    ],
  },
  tamesis: {
    id: 'seed-clinic-tamesis',
    name: 'Clinica Tamesis',
    address: 'UDMC, Sampaloc',
    phone: '(02) 8555-0200',
    hours: [{ dayOfWeek: 3, openTime: '13:00', closeTime: '16:00' }],
  },
  happy: {
    id: 'seed-clinic-happy-eyes',
    name: 'Happy Eyes',
    address: 'Doña Soledad Ave, Parañaque',
    phone: '(02) 8555-0300',
    hours: [
      { dayOfWeek: 5, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 6, openTime: '13:00', closeTime: '16:00' },
    ],
  },
};

const DEMO_PREFIX = 'demo-';
const DOCTOR_NAME = 'Dr. Angeline Pacio';

// ---- dates (clinic time is Asia/Manila, UTC+8, no daylight saving) ----------

const manilaToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const [Y, M, D] = manilaToday.split('-').map(Number) as [number, number, number];
/** A calendar date (for @db.Date columns), `offset` days from today in Manila. */
const dateOnly = (offset: number) => new Date(Date.UTC(Y, M - 1, D + offset));
/** An instant: `hour:minute` Manila time, `offset` days from today. */
const atManila = (offset: number, hour: number, minute = 0) =>
  new Date(Date.UTC(Y, M - 1, D + offset, hour - 8, minute));
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const earlier = (a: Date, b: Date) => (a < b ? a : b);

// ---- the seed ---------------------------------------------------------------

export interface SeedSummary {
  /** The existing staff accounts the demo data was attached to (this seed creates none). */
  staff: { doctor: string; secretary: string };
  patients: number;
  encounters: number;
  signedNotes: number;
  draftNotes: number;
  labResults: number;
  images: number;
  imagesSkipped: boolean;
  medications: number;
  alertCases: string[];
  followUps: { overdue: number; dueSoon: number; later: number; closed: number };
  appointments: number;
}

/** Thrown when the staff accounts the demo data attaches to do not exist yet. */
export class NoDoctorAccountError extends Error {}

export async function seedDemo(log: (msg: string) => void = console.log): Promise<SeedSummary | 'already-seeded'> {
  // ---- guards --------------------------------------------------------------
  if (await prisma.patient.findFirst({ where: { id: { startsWith: DEMO_PREFIX } }, select: { id: true } })) {
    return 'already-seeded';
  }
  const realPatients = await prisma.patient.count({
    where: { NOT: [{ id: { startsWith: DEMO_PREFIX } }, { id: { startsWith: 'seed-' } }] },
  });
  if (realPatients > 0) {
    throw new Error(
      `Refusing to load demo data: this database already holds ${realPatients} patient(s) that are not demo data.`,
    );
  }

  const summary: SeedSummary = {
    staff: { doctor: '', secretary: '' },
    patients: 0,
    encounters: 0,
    signedNotes: 0,
    draftNotes: 0,
    labResults: 0,
    images: 0,
    imagesSkipped: false,
    medications: 0,
    alertCases: [],
    followUps: { overdue: 0, dueSoon: 0, later: 0, closed: 0 },
    appointments: 0,
  };

  // ---- clinics -------------------------------------------------------------
  for (const c of Object.values(CLINICS)) {
    const existing = await prisma.clinic.findUnique({ where: { id: c.id } });
    if (!existing) {
      await prisma.clinic.create({
        data: { id: c.id, name: c.name, address: c.address, phone: c.phone, timezone: 'Asia/Manila' },
      });
      await prisma.clinicSchedule.createMany({ data: c.hours.map((h) => ({ ...h, clinicId: c.id })) });
    } else if (!existing.phone) {
      await prisma.clinic.update({ where: { id: c.id }, data: { phone: c.phone } });
    }
  }

  // ---- staff: this seed creates NO accounts ----------------------------------
  // The doctor and secretary accounts are made separately (Khyla's account
  // setup). The demo data is attached to the first active ones found.
  const doctor = await prisma.user.findFirst({
    where: { role: 'DOCTOR', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, username: true },
  });
  if (!doctor) {
    throw new NoDoctorAccountError(
      'No active Doctor account found. Create the doctor and secretary accounts first, then run the demo seed again. ' +
        'This seed does not create any user accounts.',
    );
  }
  const secretaryRow = await prisma.user.findFirst({
    where: { role: 'SECRETARY', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, username: true },
  });
  // With no secretary yet, records that name one are attributed to the doctor.
  const secretary = secretaryRow ?? doctor;
  summary.staff = { doctor: doctor.username, secretary: secretary.username };
  // Give them access to the demo clinics so the data shows on S02 and every clinic-scoped screen.
  await prisma.userClinic.createMany({
    data: Object.values(CLINICS).flatMap((c) => [
      { userId: secretary.id, clinicId: c.id },
      { userId: doctor.id, clinicId: c.id },
    ]),
    skipDuplicates: true,
  });

  const referenceVersion = getDrugReference().version;

  // ---- patients ------------------------------------------------------------
  for (const p of DEMO_PATIENTS) {
    await seedPatient(p, { doctorId: doctor.id, secretaryId: secretary.id, referenceVersion }, summary);
    summary.patients++;
  }

  await recordAudit(
    { ...SYSTEM_ACTOR, userId: doctor.id, userRole: 'SYSTEM' },
    {
      action: AuditActions.DEMO_DATA_SEEDED,
      resourceType: 'DemoData',
      resourceId: 'demo',
      metadata: { patients: summary.patients, encounters: summary.encounters, labResults: summary.labResults },
    },
  );
  log(`Loaded ${summary.patients} demo patients.`);
  return summary;
}

interface Ctx {
  doctorId: string;
  secretaryId: string;
  referenceVersion: number;
}

async function seedPatient(p: DemoPatient, ctx: Ctx, summary: SeedSummary) {
  const now = new Date();
  const clinicId = CLINICS[p.clinic].id;
  const patientId = `${DEMO_PREFIX}pt-${p.key}`;
  const firstVisit = p.visits.reduce((a, v) => Math.max(a, v.daysAgo), 0);
  const registeredAt = atManila(-(firstVisit + 1), 9);

  await prisma.patient.create({
    data: {
      id: patientId,
      ...(toDbData({
        firstName: p.firstName,
        middleName: p.middleName,
        lastName: p.lastName,
        dateOfBirth: p.dateOfBirth,
        sex: p.sex,
        civilStatus: p.civilStatus,
        occupation: p.occupation,
        mobileNumber: p.mobile,
        alternatePhone: p.alternatePhone,
        email: p.email,
        address: p.address,
        emergencyContactName: p.emergencyName,
        emergencyContactPhone: p.emergencyPhone,
        hmoProvider: p.hmo?.provider,
        hmoMemberNumber: p.hmo?.member,
        hmoValidUntil: p.hmo?.validUntil,
        philhealthNumber: p.philhealth,
        referralSource: p.referral,
        medicalHistory: p.medicalHistory,
        ophthalmicHistory: p.ophthalmicHistory,
      } as never) as Prisma.PatientUncheckedCreateInput),
      registeredClinicId: clinicId,
      createdById: ctx.doctorId,
      createdAt: registeredAt,
    },
  });

  // ---- consents ------------------------------------------------------------
  const consent = (consentType: 'DATA_PROCESSING' | 'TREATMENT' | 'CLINICAL_PHOTOGRAPHY' | 'REMINDER', channel?: 'SMS' | 'EMAIL', withdrawn = false) => ({
    patientId,
    consentType,
    channel: channel ?? null,
    isGranted: true,
    captureMethod: 'IN_PERSON' as const,
    consentedAt: registeredAt,
    recordedById: ctx.secretaryId,
    consentVersion: '2026-01',
    ...(withdrawn ? { withdrawnAt: atManila(-5, 11), withdrawnById: ctx.secretaryId } : {}),
  });
  await prisma.patientConsent.createMany({
    data: [
      consent('DATA_PROCESSING'),
      consent('TREATMENT'),
      ...(p.images?.length ? [consent('CLINICAL_PHOTOGRAPHY')] : []),
      ...p.reminders.map((ch) => consent('REMINDER', ch, p.withdrawnReminder)),
    ],
  });

  // ---- allergies (before medications, so the safety check can see them) -----
  const allergyRefs: Array<{ id: string; allergenName: string; severity: 'MILD' | 'MODERATE' | 'SEVERE' }> = [];
  for (const a of p.allergies ?? []) {
    const row = await prisma.allergy.create({
      data: {
        patientId,
        clinicId,
        allergenName: a.allergen,
        reaction: a.reaction,
        severity: a.severity,
        lookupVersion: ctx.referenceVersion,
        recordedById: ctx.doctorId,
        recordedAt: registeredAt,
      },
    });
    allergyRefs.push({ id: row.id, allergenName: a.allergen, severity: a.severity });
  }

  // ---- visits, in date order ------------------------------------------------
  const encounterIds: string[] = [];
  const appointmentIds: Array<string | null> = [];
  const order = p.visits.map((v, i) => ({ v, i })).sort((a, b) => b.v.daysAgo - a.v.daysAgo);

  for (const { v, i } of order) {
    const startedAt = v.daysAgo === 0 ? minutes(now, -45) : atManila(-v.daysAgo, 13 + (i % 3), (i * 10) % 60);
    const encounterId = `${DEMO_PREFIX}enc-${p.key}-${i}`;
    encounterIds[i] = encounterId;

    let appointmentId: string | null = null;
    if (v.booked) {
      appointmentId = `${DEMO_PREFIX}appt-${p.key}-v${i}`;
      await prisma.appointment.create({
        data: {
          id: appointmentId,
          clinicId,
          patientId,
          startsAt: startedAt,
          endsAt: minutes(startedAt, 30),
          reason: v.chiefComplaint.slice(0, 120),
          visitType: v.type === 'PROCEDURE' ? 'Procedure' : v.type === 'NEW_PATIENT' ? 'New patient' : 'Follow-up',
          status: v.signed ? 'COMPLETED' : 'CONFIRMED',
          createdAt: minutes(startedAt, -60 * 24 * 5),
        },
      });
      summary.appointments++;
    }
    appointmentIds[i] = appointmentId;

    await prisma.encounter.create({
      data: {
        id: encounterId,
        patientId,
        clinicId,
        appointmentId,
        attendingDoctorId: ctx.doctorId,
        type: v.type,
        visitDate: dateOnly(-v.daysAgo),
        visitStartedAt: startedAt,
        createdById: ctx.doctorId,
        createdAt: startedAt,
      },
    });
    summary.encounters++;

    const content: NoteContent = {
      chiefComplaint: v.chiefComplaint || null,
      subjective: v.subjective || null,
      objective: v.objective || null,
      assessment: v.assessment || null,
      plan: v.plan || null,
      diagnosisItems: v.diagnoses,
    };
    const noteId = `${DEMO_PREFIX}note-${p.key}-${i}`;
    await prisma.clinicalNote.create({
      data: { id: noteId, encounterId, noteType: 'PRIMARY', authorId: ctx.doctorId, createdAt: startedAt, ...toNoteDbData(content) },
    });

    // Findings go in while the visit is open: signing locks them.
    for (const [eye, field, value, unit] of v.findings) {
      await prisma.examFinding.create({
        data: {
          patientId,
          encounterId,
          clinicId,
          eye,
          fieldName: field,
          valueText: encrypt(value),
          unit: unit ?? null,
          measuredAt: startedAt,
          logmarValue: field === 'VA' ? toLogMAR(value, unit) : null,
          lookupVersion: EXAM_LOOKUP_VERSION,
          recordedById: ctx.doctorId,
          recordedAt: startedAt,
        },
      });
    }

    if (!v.signed) {
      summary.draftNotes++;
      continue;
    }

    const signedAt = minutes(startedAt, 40);
    const note = { encounterId, noteType: 'PRIMARY' as const, parentNoteId: null, addendumReason: null };
    await prisma.clinicalNote.update({
      where: { id: noteId },
      data: {
        status: 'SIGNED',
        signedAt,
        signedById: ctx.doctorId,
        contentHash: signatureHash(note, content, ctx.doctorId, signedAt),
        version: 2,
      },
    });
    summary.signedNotes++;

    if (v.addendum) {
      const header = { encounterId, noteType: 'ADDENDUM' as const, parentNoteId: noteId, addendumReason: v.addendum.reason };
      const addendumContent: NoteContent = {
        chiefComplaint: null,
        subjective: v.addendum.text,
        objective: null,
        assessment: null,
        plan: null,
        diagnosisItems: [],
      };
      const addendumAt = earlier(minutes(startedAt, 60 * 24 * 3), minutes(now, -60));
      await prisma.clinicalNote.create({
        data: {
          id: `${noteId}-addendum`,
          ...header,
          ...toNoteDbData(addendumContent),
          status: 'SIGNED',
          authorId: ctx.doctorId,
          signedById: ctx.doctorId,
          signedAt: addendumAt,
          contentHash: signatureHash(header, addendumContent, ctx.doctorId, addendumAt),
          createdAt: addendumAt,
        },
      });
    }
  }

  // ---- lab results ----------------------------------------------------------
  for (const l of p.labs ?? []) {
    await prisma.labResult.create({
      data: {
        patientId,
        encounterId: l.visit !== undefined ? encounterIds[l.visit] : null,
        clinicId,
        testName: l.test,
        resultValue: encrypt(l.value),
        resultUnit: l.unit,
        referenceRange: l.range ?? null,
        outOfRange: Boolean(evaluateRange(l.value, l.range)),
        collectionDate: dateOnly(-l.daysAgo),
        laboratoryName: l.lab,
        lookupVersion: LAB_LOOKUP_VERSION,
        recordedById: ctx.doctorId,
        recordedAt: atManila(-l.daysAgo, 17),
      },
    });
    summary.labResults++;
  }

  // ---- medications, with the real safety check -------------------------------
  const created: Array<{ id: string; medicationName: string; status: 'ACTIVE' | 'ON_HOLD' | 'DISCONTINUED' }> = [];
  const replaced = new Set((p.medications ?? []).flatMap((m) => (m.replaces !== undefined ? [m.replaces] : [])));
  for (const [i, m] of (p.medications ?? []).entries()) {
    const status = m.status ?? 'ACTIVE';
    const alerts = checkMedicationSafety({
      medicationName: m.name,
      allergies: allergyRefs,
      currentMedications: created.filter((c) => c.status !== 'DISCONTINUED'),
    });
    const recordedAt = atManila(-m.startDaysAgo, 15);
    const ack = alerts.length
      ? {
          acknowledgedAt: recordedAt.toISOString(),
          acknowledgedById: ctx.doctorId,
          referenceVersion: ctx.referenceVersion,
          ...(m.ackReason ? { reason: m.ackReason } : {}),
          alerts,
        }
      : null;
    const row = await prisma.medication.create({
      data: {
        patientId,
        clinicId,
        medicationName: m.name,
        strength: m.strength ?? null,
        dose: m.dose,
        frequency: m.frequency,
        route: m.route,
        instructions: m.instructions ?? null,
        indication: m.indication ?? null,
        startDate: dateOnly(-m.startDaysAgo),
        endDate: m.endDaysAgo !== undefined ? dateOnly(-m.endDaysAgo) : null,
        status,
        prescribingDoctor: DOCTOR_NAME,
        source: m.source ?? 'PRESCRIBED_HERE',
        lookupVersion: ctx.referenceVersion,
        safetyAcknowledgements: ack ? (ack as unknown as Prisma.InputJsonValue) : undefined,
        isCurrent: !replaced.has(i),
        supersedesMedicationId: m.replaces !== undefined ? created[m.replaces]?.id : undefined,
        recordedById: ctx.doctorId,
        recordedAt,
      },
    });
    created.push({ id: row.id, medicationName: m.name, status });
    summary.medications++;
    if (ack) {
      summary.alertCases.push(`${p.firstName} ${p.lastName}: ${m.name} (${alerts.map((a) => `${a.severity} ${a.type}`).join(', ')})`);
      await recordAudit(
        { ...SYSTEM_ACTOR, userId: ctx.doctorId, userRole: 'DOCTOR' },
        {
          action: AuditActions.MEDICATION_SAFETY_ALERTS_ACKNOWLEDGED,
          resourceType: 'Medication',
          resourceId: row.id,
          metadata: {
            doctorId: ctx.doctorId,
            acknowledgedAt: ack.acknowledgedAt,
            patientId,
            clinicId,
            medicationName: m.name,
            change: 'CREATED',
            referenceVersion: ctx.referenceVersion,
            reasonGiven: Boolean(m.ackReason),
            alerts: alerts as unknown as Prisma.InputJsonValue,
          },
        },
      );
    }
  }

  // ---- other appointments (upcoming, cancelled, no-show) --------------------
  for (const [i, a] of (p.appointments ?? []).entries()) {
    const startsAt = atManila(a.daysFromNow, a.hour);
    await prisma.appointment.create({
      data: {
        id: `${DEMO_PREFIX}appt-${p.key}-x${i}`,
        clinicId,
        patientId,
        startsAt,
        endsAt: minutes(startsAt, 30),
        reason: a.reason,
        visitType: a.visitType,
        status: a.status,
        cancelReason: a.cancelReason ?? null,
        createdAt: earlier(minutes(startsAt, -60 * 24 * 7), now),
      },
    });
    summary.appointments++;
  }

  // ---- follow-ups -------------------------------------------------------------
  for (const f of p.followUps ?? []) {
    const status = f.status ?? 'OPEN';
    await prisma.followUp.create({
      data: {
        patientId,
        clinicId,
        encounterId: f.visit !== undefined ? encounterIds[f.visit] : null,
        taskType: f.taskType,
        reason: f.reason,
        dueDate: dateOnly(f.dueInDays),
        priority: f.priority,
        status,
        closureNote: f.closureNote ?? null,
        createdById: ctx.doctorId,
        ...(status === 'COMPLETED' ? { completedById: ctx.secretaryId, completedAt: minutes(now, -60 * 24 * 20) } : {}),
      },
    });
    if (status !== 'OPEN') summary.followUps.closed++;
    else if (f.dueInDays < 0) summary.followUps.overdue++;
    else if (f.dueInDays <= 7) summary.followUps.dueSoon++;
    else summary.followUps.later++;
  }

  // ---- clinical images --------------------------------------------------------
  for (const [i, img] of (p.images ?? []).entries()) {
    if (summary.imagesSkipped) break;
    const imageId = `${DEMO_PREFIX}img-${p.key}-${i}`;
    const fileName = `${img.kind}-${i + 1}.png`;
    const storageKey = `patients/${patientId}/${imageId}-${fileName}`;
    const bytes = samplePng(img.kind);
    try {
      await putObjectEncrypted(storageKey, bytes, 'image/png');
    } catch (err) {
      summary.imagesSkipped = true;
      console.warn(
        `Could not upload sample images (${(err as Error).message}). Check the S3_* settings. Continuing without images.`,
      );
      break;
    }
    const takenAt = img.visit !== undefined ? atManila(-(p.visits[img.visit]?.daysAgo ?? 0), 14) : now;
    await prisma.clinicalImage.create({
      data: {
        id: imageId,
        patientId,
        appointmentId: img.visit !== undefined ? (appointmentIds[img.visit] ?? null) : null,
        uploadedById: ctx.doctorId,
        storageKey,
        fileName,
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        caption: img.caption,
        status: 'ACTIVE',
        createdAt: earlier(takenAt, now),
      },
    });
    summary.images++;
  }
}

export function printSummary(s: SeedSummary, log: (msg: string) => void = console.log) {
  log('');
  log('Demo data loaded.');
  log(`  patients ${s.patients}, visits ${s.encounters} (${s.signedNotes} signed, ${s.draftNotes} draft), lab results ${s.labResults},`);
  log(`  medications ${s.medications}, appointments ${s.appointments}, images ${s.images}${s.imagesSkipped ? ' (skipped: storage unreachable)' : ''}`);
  log(`  follow-ups: ${s.followUps.overdue} overdue, ${s.followUps.dueSoon} due within a week, ${s.followUps.later} later, ${s.followUps.closed} closed`);
  log('  allergy / safety alert cases:');
  for (const c of s.alertCases) log(`    - ${c}`);
  log('');
  log(`Attached to the existing accounts: doctor "${s.staff.doctor}", secretary "${s.staff.secretary}". No accounts were created.`);
}

// ============================================================================
// 4. Entry point
// ============================================================================

/** Run only when this file is started directly, not when a test imports it. */
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const ifEnabled = process.argv.includes('--if-enabled');
  const enabled = process.env.DEMO_SEED === 'true';
  if (ifEnabled && !enabled) return;
  if (process.env.NODE_ENV === 'production' && !enabled) {
    console.error('Refusing to load demo data in production unless DEMO_SEED=true is set.');
    process.exit(1);
  }

  let result;
  try {
    result = await seedDemo();
  } catch (e) {
    // At container start no seeding problem may stop the site from booting. The
    // data loads on a later start once the cause (e.g. no doctor account yet) is fixed.
    if (ifEnabled) {
      console.warn(`Demo data NOT loaded: ${e instanceof Error ? e.message : e}`);
      return;
    }
    throw e;
  }
  if (result === 'already-seeded') {
    console.log('Demo data is already loaded. Nothing to do. (To start over, rebuild the database: scripts/rebuild-demo-db.sh)');
    return;
  }
  printSummary(result);
}

if (isEntryPoint) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
