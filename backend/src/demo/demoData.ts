/**
 * Sample patients for the demo seed (src/demo/seedDemo.ts).
 *
 * Everything here is invented. Names, phone numbers (the 555 range) and
 * addresses do not belong to real people. Dates are written as "days ago" or
 * "days from now" so the data stays fresh whenever the seed runs: some
 * follow-ups are always due or overdue, some appointments are always upcoming.
 *
 * The patients differ on purpose (age, diagnosis, number of visits, whether
 * they have an appointment, labs, images, follow-ups) so every screen has a
 * mix of full and empty states to check.
 */
import type { DiagnosisItem } from '@clinic/schemas';

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
      { daysFromNow: 20, hour: 13, status: 'SCHEDULED', reason: 'Three-month uveitis review', visitType: 'Follow-up' },
    ],
  },

  // 13. A walk-in with one visit, no appointment, no consent to reminders, no follow-up.
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
    ],
    medications: [
      { name: 'Ofloxacin', strength: '0.3%', dose: '1 drop', frequency: '4 times a day', route: 'ophthalmic', instructions: 'Right eye for 5 days', indication: 'Corneal abrasion', startDaysAgo: 9, endDaysAgo: 4, status: 'DISCONTINUED' },
    ],
    images: [{ kind: 'slit', caption: 'Fluorescein stain, right cornea', visit: 0 }],
  },
];
