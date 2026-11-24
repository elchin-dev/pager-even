# Pager

AI pager for Telegram on Even Realities G2 smart glasses.

## Problem

## Flows

## Architecture

## Getting Started

### Server
```bash
cd server
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

Register Telegram webhook (requires HTTPS `PUBLIC_BASE_URL`):
```bash
cd server
npm run bot:set-webhook
```

### Plugin
```bash
cd plugin
cp .env.example .env
npm install
npm run dev
npm run simulate
```

## Environment Variables

See `server/.env.example` for all required backend environment variables (`PORT`, `PUBLIC_BASE_URL`, `DATABASE_PATH`, `CORS_ORIGINS`, `ENCRYPTION_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, Google OAuth, AI, and STT keys).

## Security

## Prior Art
