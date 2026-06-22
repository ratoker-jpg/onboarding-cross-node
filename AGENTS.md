# onboarding_cross production rules

This is a live production onboarding project.

Public URL:
http://178.250.243.159:8010/onboarding_cross/

Main folder:
~/apps/onboarding_cross_node

Rules:
- Keep one public URL only. Do not create versioned URLs or duplicate deploy folders.
- Update the existing onboarding_cross app in place.
- Do not edit .env or print secrets.
- Do not touch ~/web-server/server.js unless routing is explicitly requested.
- Do not edit unrelated projects in ~/web-projects.
- Before changing files, create backups in backup/YYYYMMDD_HHMMSS_task_name/.
- After JS changes, run:
  node --check server.js
  node --check onboarding_core.js
  node --check sheets_client.js
- After backend changes, restart only 8020:
  fuser -k 8020/tcp 2>/dev/null || true
  nohup ./run_forever.sh > app.log 2>&1 &
  sleep 3
  curl -i http://127.0.0.1:8020/api/onboarding/health
- Public test URL:
  http://178.250.243.159:8010/onboarding_cross/

Final report must include:
- changed files
- backup path
- checks run
- rollback command
