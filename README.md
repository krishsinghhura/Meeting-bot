# Meeting Bot Local MVP

This project is a local Google Meet bot that joins a meeting, enables captions, captures live caption text, stores transcript segments in PostgreSQL, and logs meeting/job data when the bot finishes.

The backend runs locally. Docker is used to build and launch one-off bot containers. A small Vite frontend lets you submit a meeting URL from the browser.

## Tech Stack

- Node.js and TypeScript
- Playwright for browser automation
- Express backend API
- Vite frontend
- PostgreSQL
- Prisma ORM
- Docker and Docker Compose

## What It Does

- Starts a Google Meet bot from a submitted meeting link
- Uses a signed-in Google browser state from `auth.json`
- Joins the meeting through Playwright
- Turns on captions and reads caption text from the Meet page
- Saves transcript segments to PostgreSQL
- Calls back to the local backend when the bot run completes
- Logs completion payload, meeting job, and transcript data

## Prerequisites

- Node.js 18+
- npm
- Docker Desktop or Docker Engine
- PostgreSQL database, for example Neon
- A separate Google account for the bot
- Playwright browsers

Install Playwright browsers if needed:

```bash
npm install -D playwright
npx playwright install
```

## Setup

Install dependencies from the project root:

```bash
npm install
```

Create your environment file:

```bash
cp .env.sample .env
```

Fill in the values:

```env
DATABASE_URL=postgresql://neondb_owner:your-password@your-neon-host/neondb?sslmode=require&channel_binding=require
BOT_DATABASE_URL=
BACKEND_CALLBACK_URL=http://host.docker.internal:3001
BOT_NETWORK=
GOOGLE_ACCOUNT_USER=your-bot-google-email
GOOGLE_ACCOUNT_PASSWORD=your-bot-google-password
AUTH_STATE_HOST_PATH=/absolute/path/to/meeting-bot/auth.json
AUTH_STATE_READONLY=0
AUTH_BROWSER=chrome
AUTH_BROWSER_PATH=
```

Notes:

- `DATABASE_URL` is used by the local backend.
- `BOT_DATABASE_URL` is optional. If empty, the bot uses `DATABASE_URL`.
- `BACKEND_CALLBACK_URL` is the URL bot containers use to call the backend on your host machine.
- `AUTH_STATE_HOST_PATH` can point to the generated `auth.json` file. If it is empty, the backend uses `./auth.json` when that file exists.
- `AUTH_STATE_READONLY=0` lets the bot write refreshed Playwright storage state back to `auth.json` after runs. Set it to `1` for a read-only mount.
- Do not commit `.env` or `auth.json`.

## Generate Google Auth State

Generate the signed-in browser state used by the bot:

```bash
npm run gen:auth
```

This opens a browser session for the bot account and writes the saved auth state to `auth.json`.

Refresh a still-valid saved session without doing a full login:

```bash
npm run auth:refresh
```

This opens Google Meet with the current `auth.json`, verifies that it reaches Meet as a signed-in account, and rewrites the storage state. It cannot bypass a Google sign-in, 2FA, recovery, or device challenge. If refresh reports that Google redirected to sign-in, run `npm run gen:auth` again.

## Build The Bot Image

```bash
npm run build:bot
```

Keep Docker running before using this command.

## Apply Database Migrations

The Prisma migrations are already included. Apply them to the database in `DATABASE_URL`:

```bash
npx prisma migrate deploy --schema=src/backend/schema.prisma
```

If you are changing the Prisma schema locally, use:

```bash
npx prisma migrate dev --schema=src/backend/schema.prisma
```

## Run Locally

Start the backend:

```bash
npm run dev:backend:local
```

In a second terminal, start the frontend:

```bash
npm run dev:frontend
```

Open the frontend:

```text
http://localhost:5173
```

## Run A Meeting Capture

1. Start a Google Meet from your primary Google account.
2. Copy the meeting URL before the query string.
3. Open Host Controls in the meeting.
4. Set Meeting Access to Open so the bot can join.
5. Paste the meeting URL into the local frontend.
6. Submit the form to launch the bot.
7. Speak while captions are enabled in the meeting.
8. End the meeting or say `Notetaker, please leave` when you want the bot to exit.

The frontend posts the URL to `POST /submit-link`. The backend creates a meeting job and launches one Docker bot container with `MEETING_URL=<submitted Meet URL>`. If an auth state file is available, it is mounted into the bot container at `/app/auth.json` and the bot joins as that signed-in Google account. The target meeting still needs to allow or admit that account.

When the run finishes, the transcript is saved and the backend logs the completion payload, job row, and transcript.

## Check Saved Data

Use the Neon SQL editor or connect with `psql`.

Latest transcript:

```sql
SELECT t."meetingId",
       t."createdAt",
       json_agg(
         json_build_object(
           'start',   s.start,
           'end',     s."end",
           'speaker', s.speaker,
           'text',    s.text
         )
         ORDER BY s.start
       ) AS segments
FROM   "MeetingTranscript" t
JOIN   "Segment"           s USING ("meetingId")
WHERE  t."meetingId" = (
          SELECT "meetingId"
          FROM   "MeetingTranscript"
          ORDER  BY "createdAt" DESC
          LIMIT  1
      )
GROUP  BY t."meetingId", t."createdAt";
```

Latest summary row, if summary generation is added later:

```sql
SELECT "meetingId",
       "generatedAt",
       "model",
       "summaryText"
FROM   "MeetingSummary"
ORDER  BY "generatedAt" DESC
LIMIT  1;
```

If you are using the local Docker database from older setup flows:

```bash
docker exec -it meetingbot-db psql -U meetingbot -d meetingbotpoc
```

Then list tables:

```sql
\dt
```

Press `q` to exit query result pages in `psql`, then run `exit` when you are done.

## Project Structure

```text
meeting-bot/
├── scripts/
│   └── generate-auth.js
├── src/
│   ├── backend/
│   │   ├── migrations/
│   │   ├── env.ts
│   │   ├── launchBot.ts
│   │   ├── loadEnv.ts
│   │   ├── schema.prisma
│   │   └── server.ts
│   ├── bot/
│   │   └── index.ts
│   ├── frontend/
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── style.css
│   └── playwright/
│       └── runBot.ts
├── auth.json
├── docker-compose.yml
├── Dockerfile.be
├── Dockerfile.bot
├── package.json
└── README.md
```
