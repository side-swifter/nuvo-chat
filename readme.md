Setup

1. Install dependencies

pnpm install
pnpm add @google/genai
pnpm add -D @cloudflare/workers-types

2. Create a Telegram bot

Open @BotFather on Telegram, run /newbot, and save your bot token.

Configure the bot's group privacy settings through BotFather so it can receive the group messages needed for analysis. Only use it in groups where participants understand and consent to message collection.

3. Set up Cloudflare

Log in:

pnpm exec wrangler login

Create a D1 database:

pnpm exec wrangler d1 create nuvo-chat-db

Copy the database ID into wrangler.jsonc under d1_databases.

Initialize the database:

pnpm exec wrangler d1 execute nuvo-chat-db --remote --file=./schema.sql
pnpm exec wrangler d1 execute nuvo-chat-db --remote --file=./migration.sql

4. Configure API secrets

Get a Gemini API key from Google AI Studio.

pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET

Generate a webhook secret using openssl rand -hex 24 and store it as TELEGRAM_WEBHOOK_SECRET.

5. Deploy

pnpm exec tsc --noEmit
pnpm exec wrangler deploy

Register the deployed Worker URL as your Telegram webhook using the Telegram Bot API's setWebhook endpoint. Include the same webhook secret in its secret_token field.

6. Test NUVO Chat

Add the bot to a Telegram group and have participants run /optin.

Command

Function

/start

Show instructions

/optin

Enable participation

/optout

Stop tracking

/challenge

Generate a challenge from the conversation

/leaderboard

View group rankings