#!/usr/bin/env bash
# Nightly backup (Stage 8): database dump + uploaded files, kept BACKUP_KEEP_DAYS days. Run from cron on the server:
#   15 1 * * * cd /opt/dhruv-erp && ./deploy/backup.sh >> deploy/backups/backup.log 2>&1
# Copy deploy/backups off the server (another region or an object store) after each run — a backup on the same disk is not a backup.
set -euo pipefail
cd "$(dirname "$0")"
source ./.env
KEEP="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p backups
C="docker compose -f docker-compose.prod.yml --env-file .env"
$C exec -T db pg_dump -U dhruv -d dhruv_erp --format=custom --compress=6 --file="/backups/db-$STAMP.dump"
$C run --rm --no-deps -v "$(pwd)/backups:/out" --entrypoint sh api -c "tar -czf /out/files-$STAMP.tgz -C /app storage"
# a dump that cannot be listed is not usable: fail loudly
$C exec -T db pg_restore --list "/backups/db-$STAMP.dump" > /dev/null
sha256sum "backups/db-$STAMP.dump" "backups/files-$STAMP.tgz" > "backups/$STAMP.sha256"
find backups -name 'db-*.dump' -mtime "+$KEEP" -delete
find backups -name 'files-*.tgz' -mtime "+$KEEP" -delete
find backups -name '*.sha256' -mtime "+$KEEP" -delete
echo "$(date -Is) backup $STAMP ok"
