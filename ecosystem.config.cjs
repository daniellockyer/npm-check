/**
 * PM2 ecosystem config for npm-check.
 *
 * On the server:
 *   pm2 startOrReload ecosystem.config.cjs --env production
 *   pm2 save
 */

'use strict';

const path = require('path');

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'npm-check',
      script: path.join(__dirname, 'src', 'index.ts'),
      interpreter: 'node',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
        DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || ''
      }
    }
  ]
};

