// PM2 process file for the Ozzo Helmets API + worker (no-Docker / aaPanel deployment).
// Runs under the dedicated "ozzo" user with its own PM2 daemon (never root, never "www").
// Secrets are read by Node itself from the env file (--env-file); nothing secret lives here.
// See docs/PM2-DEPLOYMENT.md.
//
//   pm2 startOrReload deploy/pm2/ecosystem.config.cjs --update-env
'use strict';

const path = require('node:path');

const APP_DIR = process.env.OZZO_APP_DIR || path.resolve(__dirname, '..', '..');
const ENV_FILE = process.env.OZZO_ENV_FILE || '/etc/helmet-platform/app.env';
const LOG_DIR = process.env.OZZO_LOG_DIR || '/var/log/ozzohelmets';

// Build metadata (shown to admins only); exported by scripts/pm2-deploy.sh.
const buildEnv = {
  NODE_ENV: 'production',
  APP_VERSION: process.env.APP_VERSION || '0.0.0-dev',
  GIT_SHA: process.env.GIT_SHA || 'unknown',
  BUILD_DATE: process.env.BUILD_DATE || 'unknown',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
};

const common = {
  cwd: path.join(APP_DIR, 'apps', 'api'),
  node_args: [`--env-file=${ENV_FILE}`],
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  exp_backoff_restart_delay: 200,
  kill_timeout: 15000,
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'ozzo-api',
      script: 'dist/main.js',
      max_memory_restart: '768M',
      out_file: path.join(LOG_DIR, 'api.out.log'),
      error_file: path.join(LOG_DIR, 'api.err.log'),
      env: { ...buildEnv },
    },
    {
      ...common,
      name: 'ozzo-worker',
      script: 'dist/worker.js',
      max_memory_restart: '384M',
      out_file: path.join(LOG_DIR, 'worker.out.log'),
      error_file: path.join(LOG_DIR, 'worker.err.log'),
      env: { ...buildEnv, WORKER_HEARTBEAT_FILE: '/tmp/ozzo-worker-heartbeat' },
    },
  ],
};
