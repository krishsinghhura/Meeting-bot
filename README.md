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
TEAMS_AUTH_STATE_HOST_PATH=/absolute/path/to/meeting-bot/teams-auth.json
TEAMS_ADMISSION_TIMEOUT_MS=600000
AUTH_BROWSER=chrome
AUTH_BROWSER_PATH=
AUTH_COOKIE_SECURE=0
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=low
OPENAI_VERBOSITY=low
OPENAI_TRANSCRIPT_MAX_CHARS=60000
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your-server-secret
SUPABASE_STORAGE_BUCKET=meeting-artifacts
SUPABASE_STORAGE_PUBLIC=0
```

Notes:

- `DATABASE_URL` is used by the local backend.
- `BOT_DATABASE_URL` is optional. If empty, the bot uses `DATABASE_URL`.
- `BACKEND_CALLBACK_URL` is the URL bot containers use to call the backend on your host machine.
- `AUTH_STATE_HOST_PATH` can point to the generated `auth.json` file. If it is empty, the backend uses `./auth.json` when that file exists.
- `TEAMS_AUTH_STATE_HOST_PATH` can point to generated Microsoft Teams auth state. If it is empty, the backend uses `./teams-auth.json` when that file exists.
- Auth state files are mounted read-only into bot containers. Normal bot runs never rewrite `auth.json` or `teams-auth.json`.
- `TEAMS_ADMISSION_TIMEOUT_MS` controls how long the Teams bot waits in the lobby after asking to join.
- `AUTH_COOKIE_SECURE=0` is correct for local `http://localhost` development. Set it to `1` when serving the app over HTTPS.
- `OPENAI_API_KEY` enables structured meeting analysis after transcript/VTT finalization. If it is empty, the backend skips AI generation and still saves the transcript and VTT artifact.
- `OPENAI_MODEL` defaults to `gpt-5.5`; set it to a pinned or lower-cost model when you are ready to optimize cost and latency.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_STORAGE_BUCKET` are required for VTT artifact uploads. `SUPABASE_SECRET_KEY` is backend-only and must not be exposed in browser code.
- `SUPABASE_STORAGE_PUBLIC=0` stores a private object URL in `MeetingArtifact.storagePath`. Set it to `1` only if the bucket is public and you want `storagePath` to be a public URL.
- Do not commit `.env`, `auth.json`, or `teams-auth.json`.

## Generate Google Auth State

Generate the signed-in browser state used by the bot:

```bash
npm run gen:auth
```

This opens a browser session for the bot account and writes the saved auth state to `auth.json`.

If the saved Google session expires or starts landing on sign-in/challenge pages, run `npm run gen:auth` again and replace `auth.json` with the newly generated known-good state.

Generate the signed-in Microsoft Teams browser state used by Teams bot runs:

```bash
npm run gen:teams-auth
```

This opens a browser session for the Microsoft account. Complete sign-in and wait until Teams itself is loaded before pressing Enter. The script writes `teams-auth.json`.

Teams auth is separate from Google auth. `auth.json` is only for Google Meet; `teams-auth.json` is only for Microsoft Teams.

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

The frontend now requires email/password login. Accounts, password hashes, sessions, and user-owned meeting jobs are stored in the same Neon database configured by `DATABASE_URL`.

## Run A Meeting Capture

1. Start a Google Meet from your primary Google account.
2. Copy the meeting URL before the query string.
3. Open Host Controls in the meeting.
4. Set Meeting Access to Open so the bot can join.
5. Paste the meeting URL into the local frontend.
6. Submit the form to launch the bot.
7. Speak while captions are enabled in the meeting.
8. End the meeting or say `Notetaker, please leave` when you want the bot to exit.

After login, the frontend posts the URL to `POST /submit-link`. The backend detects the provider, creates a meeting job owned by the signed-in user, and launches one Docker bot container with `MEETING_URL=<submitted meeting URL>`.

For Google Meet, `auth.json` is mounted at `/app/auth.json` when available. For Microsoft Teams, `teams-auth.json` is mounted at `/app/teams-auth.json` when available. If the provider-specific auth file is missing, the bot falls back to guest web join. The target meeting still needs to allow or admit the bot account.

When the run finishes, the transcript is saved and the backend uploads the VTT artifact to Supabase Storage before running AI analysis. If `OPENAI_API_KEY` is configured, the backend then generates a structured meeting analysis and stores it in `MeetingAiResult`.

Signed-in users can view only their own jobs and results through:

```text
GET /jobs
GET /jobs/:jobId
```

## Generate AI Analysis For An Existing Transcript

Full payload, output, storage, and testing docs are in [`docs/openai-meeting-analysis.md`](docs/openai-meeting-analysis.md).

Run the OpenAI analysis on the latest saved transcript:

```bash
npm run summarize:meeting
```

Run it for one meeting:

```bash
npm run summarize:meeting -- ccbf8caf-5371-4bc7-9bd0-79b8fc224f36
```

Inspect the cleaned transcript that will be sent to OpenAI without making an API call:

```bash
npm run summarize:meeting -- ccbf8caf-5371-4bc7-9bd0-79b8fc224f36 --dry-run
```

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

Latest AI analysis row:

```sql
SELECT "meetingId",
       "generatedAt",
       "model",
       "outputJson"
FROM   "MeetingAiResult"
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
