# npm-check

Monitors newly published npm package versions and flags publishes that **introduce** a `preinstall` or `postinstall` script. These lifecycle scripts can pose security risks, as they execute automatically during package installation and may be introduced in updates without users noticing.

The tool uses npm's replicate database (`replicate.npmjs.com`) to track changes, then fetches full package metadata from the registry to compare scripts between versions.

## Features

- Monitors npm for new packages with `preinstall` or `postinstall` scripts.
- Sends notifications to Telegram, Discord, or both.
- Creates GitHub issues in the package's repository when a new script is detected.

## Configuration

The application is configured using environment variables. You can set them in your shell, or by creating a `.env` file in the root of the project.

| Variable              | Description                                                                                                | Default                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `NPM_REPLICATE_DB_URL`  | The URL of the npm replicate database.                                                                     | `https://replicate.npmjs.com/`      |
| `NPM_CHANGES_URL`       | The URL of the npm `_changes` feed.                                                                        | `https://replicate.npmjs.com/_changes` |
| `NPM_REGISTRY_URL`      | The URL of the npm registry.                                                                               | `https://registry.npmjs.org/`       |
| `MAX_CONCURRENCY`       | The maximum number of packages to process concurrently.                                                    | `10`                                |
| `CHANGES_LIMIT`         | The maximum number of changes to fetch per request.                                                        | `200`                               |
| `POLL_MS`               | The polling interval in milliseconds.                                                                      | `1500`                              |
| `TELEGRAM_BOT_TOKEN`    | Your Telegram bot token.                                                                                   | ` `                                 |
| `TELEGRAM_CHAT_ID`      | The ID of the Telegram chat to send notifications to.                                                      | ` `                                 |
| `DISCORD_WEBHOOK_URL`   | The URL of the Discord webhook to send notifications to.                                                   | ` `                                 |
| `GITHUB_TOKEN`          | Your GitHub personal access token with `public_repo` scope. Used for creating issues.                      | ` `                                 |

## Usage

It is recommended to run this application with a process manager like PM2.

1.  Clone the repository.
2.  Install dependencies with `npm install`.
3.  Copy `.env.example` to `.env` and fill in the values.
4.  Start the application with `pm2 startOrReload ecosystem.config.cjs --env production`.
5.  Save the PM2 process list with `pm2 save`.

## Author

**Daniel Lockyer** <hi@daniellockyer.com>

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
