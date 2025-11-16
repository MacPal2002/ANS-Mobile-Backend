# ANS Mobile Backend

This repository is the backend for the ANS Mobile application — a Firebase Cloud Functions TypeScript project that implements authentication, HTTP endpoints, scheduled jobs and background task handlers used by the mobile client.

---

## Quick summary

- Platform: Firebase Cloud Functions
- Language: TypeScript
- Main folder containing the functions runtime: `functions/`

Notable dependencies used across the codebase indicate:
- firebase-admin, firebase-functions — Firebase backend
- @google-cloud/secret-manager — secrets retrieval
- @google-cloud/pubsub, @google-cloud/tasks — asynchronous processing & scheduling
- axios, jsdom — HTTP requests + HTML parsing (scraping / metadata)
- resend — transactional email sending

---

## How the project is organized

Top-level of the Firebase functions source (functions/src):

- config/ — configuration constants and mapping modules (e.g., URLs, notification config)
- http/ — HTTP callable and HTTP-onRequest handlers used by the mobile app and external webhooks
- scheduler/ — scheduled jobs (cron-like tasks) triggered by Cloud Scheduler / functions.pubsub.schedule
- tasks/ — background workers / task handlers (Cloud Tasks or Pub/Sub handlers)
- utils/ — helper utilities: wrappers for admin, HTTP, parsing, secret manager
- types.ts — TypeScript types & payload interfaces used across the codebase
- index.ts — function exports and global initialization
