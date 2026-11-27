# Running the clinic jobs

The web API and the worker must use the same migrated database, application keys, documents bucket and durable Redis instance. The worker registers BullMQ schedules at startup. The default clinic timezone is Asia/Manila. Daily database and file snapshots, an independent audit archive and routine recall evaluation use `BACKUP_CRON`. Export cleanup and retention use `PURGE_CRON`. Consent-based reminders use `REMINDER_SCAN_CRON`. Doctors configure recall intervals on individual routine check-ups. Free-text legacy recall instructions need Doctor review before automation.

## Worker and storage

1. Choose an existing always-on host and a Redis service with persistent storage, authentication, restricted network access and the `noeviction` memory policy. For self-hosted Redis, enable AOF on a persistent volume and test restart recovery. Ensure continued availability of PostgreSQL and both object stores.
2. Prepare a private worker environment from `backend/.env.example`. Use a separate backup bucket with separate access controls. The worker needs read access to uploaded files and read/write access to its backup destination. Provision both buckets in advance. Escrow the 32-byte `BACKUP_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY`, `BLIND_INDEX_KEY` and every applicable `PRISMA_FIELD_ENCRYPTION_KEY` independently of the database. Keep the key associated with each retained backup. Size the worker for the database dump and the largest uploaded file.
3. Apply the app migrations. Start the opt-in worker on the approved host with the command below. Set `BACKGROUND_JOBS_ENABLED=false` and `REMINDERS_ENABLED=false` on the web API when the standalone worker owns the queues. The worker always processes maintenance and exports. Set `REMINDERS_ENABLED` on the worker according to the clinic's messaging configuration.

```sh
WORKER_ENV_FILE=/path/to/private-worker.env docker compose -f compose.worker.yaml up -d --build
```

Set the required PostgreSQL TLS options for the backup client, such as `PGSSLMODE=verify-full` and `PGSSLROOTCERT` for a verified connection. The image includes PostgreSQL 16 clients. Match the clients to the database major version. Startup checks the dump and restore binaries, the backup key and destination. The worker recreates schedules and queues a missing daily backup after an outage. Persisted export requests and pending reminder claims can be republished with their original job IDs. A claim already submitted to a provider needs provider evidence before a repeat send.

On free Render, the web process sleeps after 15 minutes without inbound traffic, its filesystem is ephemeral, and free Key Value loses queue data on restart. Outbound SMTP ports 25, 465 and 587 are blocked on free web services. These constraints affect scheduling, job recovery and mail delivery independently. An operator must supply and verify the worker host and durable services. This configuration creates a worker container only when explicitly run. [Render free-service limits](https://render.com/docs/free)

## Monitor and recover

Alert on exhausted or stalled BullMQ jobs and on the absence of a successful `BACKUP_COMPLETED` for either `database-backup` or `audit-backup` within a day. Failures record `BACKUP_FAILED`. Check distribution of completion times, storage access, object versions, available memory, clock and key availability. After correcting a failure, run the affected job again and verify the new archive. Keep this monitoring independent of the worker so suspension is visible.

Database dumps commit under `db/` after all encrypted upload blobs and the dump-specific encrypted manifest have been written. Restore uses the manifest to read the exact file versions and verify SHA-256. Temporary report exports are excluded. The independent daily audit data archive lives under `audit/`. Configure storage protection and lifecycle rules to retain audit archives for at least five years and database backups for at least 30 days. The job preserves the newest database backup and retains upload blobs needed by any snapshot. The application does not expire audit archives or delete patient records or clinical files. Clinic approval is required for clinical deletion or backup-blob reclamation.

On a recovery host with the matching keys and read access, list dumps and extract one into a private directory. Use a new output filename and a new, empty upload directory. Restore the dump to an empty isolated database and copy recovered files to a separate target bucket under the original object keys.

```sh
npm run db:restore-backup -w backend -- --list
npm run db:restore-backup -w backend -- --key "$SNAPSHOT_KEY" --out snapshot.dump --files-to restored-uploads
createdb clinic_restored
pg_restore --exit-on-error --no-owner --dbname clinic_restored snapshot.dump
```

A separate `audit/*.dump.enc` uses the same decryption command without `--files-to`. Apply migrations to a clean database with an empty audit table before importing that data-only archive. Older backups without a manifest use their original `files/` copies. Their exact upload versions can be confirmed only if independent historical versions exist.

### Isolated restore drill

Use disposable local PostgreSQL, Redis and S3-compatible services, a PostgreSQL role with database creation privileges, and fresh test values for the application and backup keys. Use loopback URLs in `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT` and any `BACKUP_S3_ENDPOINT`. Run the drill from the repository root.

```sh
NODE_ENV=test npm run db:restore-drill -w backend
```

The drill creates three databases and three uniquely named buckets. It backs up synthetic records and an upload, overwrites the upload, takes another backup, and restores the first snapshot into independent storage. It checks the original bytes and recovery after a backup-key rotation, logs in through the restored application, reads medication and follow-up records, and verifies the audit chains in both restored databases. The generated databases and plaintext scratch dumps are removed. Discard the test object-store instance after the run.

## Messaging decisions

Disabled channels are visible in Outreach. A simulated legacy send is displayed as simulated. Manual attempts use the server clock. SMTP acceptance is displayed as sent while final delivery is pending. An uncertain send stays pending confirmation and is excluded from automatic resends.

| If selected | Information and verification needed from the clinic |
| --- | --- |
| Twilio SMS | Account SID, auth token, approved sender or messaging service SID, public HTTPS base URL and a test recipient. The adapter signs in to create messages and validates Twilio's signed status callback, including the per-delivery correlation URL. Verify final receipts with a provider test account. |
| Semaphore SMS | API key, approved sender and test access to a supported delivery-status lookup. Confirm the provider's status definitions and finish authenticated polling before enabling it for production. |
| Email | Approved sender/domain and relay credentials, permitted network egress and the provider's authenticated bounce/delivery interface. Verify acceptance, delivery, bounce and recovery with provider test addresses. An SMTP Message-ID is a tracing value and provides no deduplication guarantee. |

The generic SMS receipt endpoint requires the `x-webhook-secret` header and a known provider message ID. Use it only for a trusted integration that can authenticate the originating receipt. Provider guidance is available in [Twilio status callbacks](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status) and [Twilio webhook authentication](https://www.twilio.com/docs/usage/security).
