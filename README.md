# Google Meet Meeting Bot

This is a PoC that joins a Google Meet, scrapes live captions, and stores the transcript in PostgreSQL. This local version has summary generation disabled and logs the backend data when the bot finishes.

If you're interested in the process, reasoning, demos, and more, [check out the blog](https://www.recall.ai/blog/how-we-built-an-in-house-google-meet-bot).

## Hosted Google Meet Bot
If you don't want to host a bot yourself, check out [Recall.ai](https://www.recall.ai/?utm_source=github&utm_medium=sampleapp&utm_campaign=google-meet-bot-from-scratch)

## Tech Stack
- Node.js / TypeScript
- Playwright (headless browser bot)
- PostgreSQL
- Docker + Docker Compose
- Prisma ORM
- Express (API) + simple HTML (frontend)

## Steps

- Join Meet using Playwright
- Scrape captions from the DOM
- Flush transcript to PostgreSQL
- Log transcript/job data in the backend
- Create web UI so that meeting links can be submitted

## How to run the project

1. Install prereqs
    - [Docker](https://docs.docker.com/get-started/get-docker/) ()
    - Install node and a package manager
        - Option 1: 
            - Brew install node by opening terminal and running `brew install node` then confirming installation by running `node -v` and `npm -v` (if you don't have homebrew installed, start by [installing homebrew](https://brew.sh/) on your machine)
        - Option 2: 
            - Open terminal and run `sudo apt install nodejs` then run `node -v` to confirm installation
            - npm on Linux: run `sudo apt install npm` then `npm -v` to confirm installation
        
    - [Git](https://git-scm.com/downloads)
    - A second [Google account](https://accounts.google.com) to join meetings (you will manually start a meeting using one account of your choosing and then your bot will need an account to join the meetings from)
    - Install Playwright `npm install -D playwright` then `npx playwright install`

2. Clone the Repository

```bash
git clone https://github.com/recallai/google-meet-meeting-bot.git
cd google-meet-meeting-bot
```

3. run ```npm install```

4. To copy the .env.sample file and rename to .env in root by running this: 

    ``` 
    cp .env.sample .env
    ```

    replacing the placeholder values for your own values:
    ```
    DATABASE_URL=postgresql://meetingbot:supersecret@postgres:5432/meetingbotpoc
    GOOGLE_ACCOUNT_USER=your-second-google-email
    GOOGLE_ACCOUNT_PASSWORD=your-second-google-password
    AUTH_STATE_HOST_PATH=/absolute/path/to/google-meet-meeting-bot/auth.json
    ```

5. Run the `generate-auth.js` script in `scripts/`
```
npm run gen:auth
```

> Do NOT commit your `auth.json` or `.env` file to Git. I've already added both to `.gitignore`
> If you skip this step, the bot image still builds and the bot logs that it is continuing without a signed-in Google session.


7. Run your code: 
```
docker-compose build --no-cache
docker compose up -d
```
> If you get an error when you run the above, make sure your Docker desktop app is open (the app you installed at the beginning)
8. Run Database Migrations

Prisma's migration files are already included in the repo. To apply copy and paste the following in terminal (the first cmd opens a shell and the second deploys the migration):
 
```
docker compose exec backend sh
npx prisma migrate deploy
```

This will apply the schema to your local PostgreSQL instance (spun up by Docker). To confirm you can try the cmds in the appendix

and you should see tables now, but that is not necessary.

> Note: If you're modifying the schema yourself, use `npx prisma migrate dev` instead to generate new migrations.

9. Exit out of your shell by typing `exit` and hitting enter then re-run your code: 
```
docker-compose build --no-cache
docker compose up -d
```

10. Open a **second terminal** window and run
```
cd src/frontend
npm install
npm run dev
```

11. Start a Google Meet
- Start a meeting with your primary Google account (not the bot account you created)
- copy the url before the '?' (put in a note or somewhere you can return to)
- Go to the "Host Controls" in the bottom right-hand corner
- Select "Open" in "Meeting Access"

12. Navigate to your basic frontend
- Open a new tab
- Paste the following url: 
http://localhost:5173
- Copy the meeting url you stored in the previous step
- Paste it into your bar and hit submit

13. Conduct your meeting
- Make sure you are unmuted in the Google Meet tab you have open 
- Have a conversation and when you want your bot to leave, either end the meeting or say "Notetaker, please leave" 
- The bot will save the transcript and the backend will log the completion payload, job, and transcript.


14. Checking your data
to access postgres go to the terminal window where you built docker and run: 
```
docker exec -it meetingbot-db psql -U meetingbot -d meetingbotpoc
```
then 
- To see saved transcript-related summary rows, if you add summary generation later:
```sql
SELECT "meetingId",
       "generatedAt",
       "model",
       "summaryText"
FROM   "MeetingSummary"
ORDER  BY "generatedAt" DESC
LIMIT  1;
```
- To see your transcript: 
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

> **REMEMBER to hit 'q' everytime you want to exit out of the specific query results from the queries above and when you are done looking into what is in your database (postgreSQL) type `exit` again**

Happy meeting!

## Project Structure

```
google-meet-meeting-bot/
├── scripts/
│   ├── generate-auth.js
├── src/
│   ├── backend/
│   │   ├── migrations/
│   │   ├── server.ts
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   ├── tsconfig.json
│   │   ├── launchBot.ts
│   │   └── schema.prisma
│   ├── bot/
│   │   ├── index.ts
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   └── tsconfig.json
│   └── frontend/
│       ├── index.html   # form
│       ├── main.ts
│       ├── style.css
│       ├── tsconfig.json
│       ├── package.json
│       └── package-lock.json
├── playwright/
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── runBot.ts
│   ├── storage.ts
│   ├── models.ts
│   └── summarize.ts
├── package.json
├── tsconfig.json
├── .env
├── Dockerfile.be
├── Dockerfile.bot
├── docker-compose.yml
├── auth.json            # created by logging into the site via playwright and then storing credentials
└── README.md
```

### Bonus: Want Something More Scalable?
 If you're set making this production-ready or integrating with other platforms (Zoom, Teams, Meet), check out [Recall.ai](https://www.recall.ai/). We provide a [Desktop Recorder SDK](https://docs.recall.ai/docs/desktop-sdk) and multi-platform meeting bot infrastructure, which can simplify and scale what this PoC demonstrates.

I know I'm biased, but I high recommended looking into the Recall.ai API if you're looking to move beyond prototypes or checking out some of [our customers and case studies](https://recall-ai.webflow.io/customers) if you're wondering how you might leverage conversation data in your product.

### Appendix
To confirm your prisma tables you can run 
```
docker exec -it meetingbot-db psql -U meetingbot -d meetingbotpoc
```
then
```
\dt
```

### Huge Thanks To...
Amanda for giving me the opportunity to work on this project. YK for showing me the ropes. Antonio for the eng side onboarding. An an extra huge shoutout to Gerry for his invaluable feedback which has made this so simple to run that my mom (not an engineer) could do it. The entire Recall.ai team for being such a stellar and generous team!

<img src="https://recall.ai/pixel-7f38da2c95a84e169c43e6b1d14c7e29?repo=google-meet-meeting-bot" width="1" height="1" style="display:none;" alt="" />
