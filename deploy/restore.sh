#!/usr/bin/env bash
# Restore a backup made by backup.sh:  ./deploy/restore.sh 20270101-0115
# Rehearse this on a spare server before go-live (go-live checklist: "Backups run and a restore was rehearsed").
set -euo pipefail
cd "$(dirname "$0")"
STAMP="${1:?give the backup stamp, e.g. 20270101-0115}"
source ./.env
sha256sum -c "backups/$STAMP.sha256"
C="docker compose -f docker-compose.prod.yml --env-file .env"
read -r -p "This replaces the database and files on THIS server with backup $STAMP. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || { echo "stopped"; exit 1; }
$C stop api worker
$C exec -T db dropdb -U dhruv --if-exists dhruv_erp
$C exec -T db createdb -U dhruv dhruv_erp
$C exec -T db pg_restore -U dhruv -d dhruv_erp --no-owner "/backups/db-$STAMP.dump"
$C run --rm --no-deps -v "$(pwd)/backups:/in" --entrypoint sh api -c "rm -rf /app/storage/* && tar -xzf /in/files-$STAMP.tgz -C /app"
$C up -d api worker
echo "restored $STAMP — sign in and check the audit log chain (Administration → Audit → Verify)"
