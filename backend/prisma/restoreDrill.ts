/**
 * Disposable restore exercise. Run with NODE_ENV=test, loopback PostgreSQL,
 * Redis and S3 (see WORKER.md). Every database and bucket is created for this run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const loopback = (value: string | undefined) => value && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
const database = new URL(process.env.DATABASE_URL!);
const runId = process.env.DRILL_ID || 'drill_' + randomUUID().replaceAll('-', '');
const patientId = 'drill-patient';
const expected = Buffer.from('synthetic uploaded file\n');
const doctorPassword = 'DrillOnly!Pass123';
function run(binary: string, args: string[], env = process.env) {
  const result = spawnSync(binary, args, { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed (exit ${result.status})`);
}
async function fixture() {
  const { hashPassword } = await import('../src/auth/auth.service.js');
  const { prisma } = await import('../src/prisma.js');
  const { testPatientData } = await import('../src/test-utils/patientData.js');
  const { writeAudit } = await import('../src/audit/audit.service.js');
  const { SYSTEM_ACTOR } = await import('../src/audit/record.js');
  const { s3, putObject } = await import('../src/storage/s3.js');
  const { CreateBucketCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { verifyBackupTools, runBackup, runAuditBackup, readEncryptedObject, restoreFiles, createBackupClient, loadBackupKey } =
    await import('../src/maintenance/backup.js');
  verifyBackupTools();
  for (const Bucket of [process.env.S3_BUCKET!, process.env.BACKUP_S3_BUCKET!, process.env.DRILL_FILES!])
    await s3.send(new CreateBucketCommand({ Bucket }));
  const clinic = await prisma.clinic.create({ data: { id: 'drill-clinic', name: 'Restore drill' } });
  const user = await prisma.user.create({ data: { role: 'DOCTOR', status: 'ACTIVE', username: 'drill-doctor',
    email: 'drill@example.invalid', fullName: 'Drill Doctor', passwordHash: await hashPassword(doctorPassword) } });
  await prisma.patient.create({ data: { ...testPatientData(clinic.id, user.id), id: patientId } });
  await prisma.medication.create({ data: { patientId, clinicId: clinic.id, medicationName: 'Drill medicine',
    dose: 'test', route: 'test', frequency: 'test', startDate: new Date(), recordedById: user.id, prescribingDoctor: 'Drill prescriber' } });
  await prisma.followUp.create({ data: { clinicId: clinic.id, patientId, taskType: 'CHECK_UP', reason: 'Synthetic recall',
    dueDate: new Date(), createdById: user.id } });
  await writeAudit({ ...SYSTEM_ACTOR, action: 'RESTORE_DRILL_FIXTURE', resourceType: 'Patient', resourceId: patientId, statusCode: null, metadata: { clinicId: clinic.id } });
  await putObject('uploads/synthetic.txt', expected, 'text/plain');
  const first = await runBackup();
  const rotatedKey = randomBytes(32);
  const rotated = await runBackup({ key: rotatedKey });
  assert.equal(await restoreFiles(createBackupClient(), rotated.databaseKey, rotatedKey,
    async (_file, bytes) => { assert.deepEqual(bytes, expected); }), 1);
  await putObject('uploads/synthetic.txt', Buffer.from('changed after snapshot'), 'text/plain');
  await runBackup();
  const audit = await runAuditBackup();
  const client = createBackupClient(), key = loadBackupKey();
  for (const [file, archive] of [['database.dump', first.databaseKey], ['audit.dump', audit.databaseKey]]) {
    writeFileSync(join(process.env.DRILL_TMP!, file!), await readEncryptedObject(client, archive!, key), { mode: 0o600 });
  }
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  assert.equal(await restoreFiles(client, first.databaseKey, key, async (file, bytes) => {
    await s3.send(new PutObjectCommand({ Bucket: process.env.DRILL_FILES, Key: file.key, Body: bytes, ContentType: file.contentType }));
  }), 1);
  const got = await s3.send(new GetObjectCommand({ Bucket: process.env.DRILL_FILES, Key: 'uploads/synthetic.txt' }));
  assert.deepEqual(Buffer.from(await got.Body!.transformToByteArray()), expected);
  await prisma.$disconnect();
}

async function checkRestored(auditOnly: boolean) {
  const { verifyChain } = await import('../src/audit/audit.service.js');
  const { prisma } = await import('../src/prisma.js');
  const integrity = await verifyChain();
  assert.equal(integrity.ok, true);
  assert.ok(integrity.total >= 1);
  if (!auditOnly) {
    const { createApp } = await import('../src/app.js');
    const { default: request } = await import('supertest');
    const staff = request.agent(createApp());
    await staff.post('/api/auth/login').send({ username: 'drill-doctor', password: doctorPassword }).expect(200);
    await staff.post('/api/auth/select-clinic').send({ clinicId: 'drill-clinic' }).expect(200);
    const meds = await staff.get('/api/medications').query({ patientId }).expect(200);
    assert.equal(meds.body.items[0].medicationName, 'Drill medicine');
    const followUps = await staff.get('/api/follow-ups').query({ patientId }).expect(200);
    assert.equal(followUps.body.items[0].reason, 'Synthetic recall');
    assert.equal((await verifyChain()).ok, true);
  }
  await prisma.$disconnect();
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  for (const value of [database.href, process.env.REDIS_URL, process.env.S3_ENDPOINT]) assert.ok(loopback(value), 'Use disposable loopback services');
  if (process.env.BACKUP_S3_ENDPOINT) assert.ok(loopback(process.env.BACKUP_S3_ENDPOINT));
  if (process.argv[2] === 'fixture') return fixture();
  if (process.argv[2] === 'check' || process.argv[2] === 'check-audit') return checkRestored(process.argv[2] === 'check-audit');

  const scratch = mkdtempSync(join(tmpdir(), 'emr-restore-'));
  const pgEnv = { ...process.env, PGHOST: database.hostname, PGPORT: database.port || '5432',
    PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password) };
  const childEnv = (suffix: string) => {
    const target = new URL(database);
    target.pathname = '/' + runId + suffix;
    return { ...pgEnv, DATABASE_URL: target.href, DRILL_ID: runId, DRILL_TMP: scratch,
      S3_BUCKET: runId.replace('_', '-') + '-source', BACKUP_S3_BUCKET: runId.replace('_', '-') + '-backup',
      DRILL_FILES: runId.replace('_', '-') + '-restored', BACKGROUND_JOBS_ENABLED: 'false', REMINDERS_ENABLED: 'false' };
  };
  const created: string[] = [];
  try {
    for (const suffix of ['_source', '_restored', '_audit']) {
      const name = runId + suffix;
      run('createdb', [name], pgEnv);
      created.push(name);
    }
    run('npm', ['run', 'prisma:migrate:deploy'], childEnv('_source'));
    run(process.execPath, ['--import', 'tsx', self, 'fixture'], childEnv('_source'));
    for (const [suffix, file, check] of [['_restored', 'database.dump', 'check'], ['_audit', 'audit.dump', 'check-audit']]) {
      if (check === 'check-audit') run('npm', ['run', 'prisma:migrate:deploy'], childEnv(suffix!));
      const input = join(scratch, file!);
      assert.equal(readFileSync(input).subarray(0, 5).toString(), 'PGDMP');
      run(process.env.PG_RESTORE_PATH || 'pg_restore', ['--exit-on-error', '--no-owner', '--dbname', runId + suffix, input], pgEnv);
      run(process.execPath, ['--import', 'tsx', self, check!], childEnv(suffix!));
    }
    console.log('PASS: database and separate audit restore, snapshot file bytes, key rotation, login, medication, follow-up and audit chain');
  } finally {
    for (const name of created) run('dropdb', [name], pgEnv);
    rmSync(scratch, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
