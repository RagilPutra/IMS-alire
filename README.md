# Alire Inventory — standalone deploy

This is the real, standalone version of the inventory app: a Node/Express
server backed by Postgres, replacing the Claude-artifact database the app
used to run on. The frontend (`index.html`) is the exact same ~6000-line
app you already had — only a small compatibility shim was added at the top
of its script, so it keeps talking to `claude.use('db')` etc., just now
backed by this server's REST API instead.

It comes pre-loaded with a full export of your real data: 822 items, 822
stock records, all suppliers, transactions, stock-opname sessions/details.
Run the migration step below once and it's all there.

## What's included

- `index.html` — the app, unchanged except for the small shim at the top of its `<script>` block.
- `src/server.js` — Express server: serves the app, exposes a REST API, serves uploaded PDFs at `/_blob/:id`.
- `src/db.js`, `src/lock.js` — Postgres connection and the stock-adjustment lock.
- `schema.sql` — the Postgres schema (created automatically on first boot).
- `migrate/seed.js` + `migrate/seed-data.json` — one-time loader for your existing data.
- `railway.json`, `Procfile` — Railway deploy config.

## 1. Push this to your own GitHub repo

From this folder:

```bash
git init
git add -A
git commit -m "Initial commit: standalone Alire Inventory app"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(A commit has already been made for you in this zip — if `git log` already
shows one, skip straight to adding your remote and pushing.)

## 2. Deploy to Railway

1. Go to [railway.app](https://railway.app) and click **New Project**.
2. Choose **Deploy from GitHub repo** and pick the repo you just pushed.
3. In the same project, click **+ New** → **Database** → **Add PostgreSQL**.
   Railway automatically sets a `DATABASE_URL` variable on your app service
   that points at it — you don't need to copy anything by hand.
4. Open your app service's **Variables** tab and add:
   - `APP_KEY` — any long random string (e.g. run `openssl rand -hex 24` locally and paste the result). This is the shared secret that protects your API.
5. Deploy. Railway will run `npm install` then `npm start` automatically
   (from `railway.json`). On first boot the server creates all the
   required tables itself (from `schema.sql`) — no manual SQL needed.
6. Once it's live, load one of your data collections with the migration
   script, run **once**, from your local machine (with the [Railway CLI](https://docs.railway.app/guides/cli)):

   ```bash
   railway link          # pick this project
   railway run npm run migrate
   ```

   This loads all 822 items, 822 stock records, suppliers, transactions,
   and stock-opname history into the new database. It's safe to re-run —
   it just re-syncs the same records, it won't duplicate anything.

7. Open the URL Railway gives your service. The app should load and behave
   exactly like it did before, now backed by a real database.

If you'd rather run the migration without installing the Railway CLI, you
can instead set `DATABASE_URL` in your own terminal (copy the value from
Railway's Postgres service → **Connect** tab → "Postgres Connection URL",
using the **public** one, not the internal one, since you're running this
from outside Railway's network) and just run `npm run migrate` locally.

## Login

Login is unchanged from before — the same demo accounts and passwords
(`admin123`) the app already used, plus any custom accounts you create from
Settings (stored in the `users` collection, same as before). This was a
deliberate choice to keep things simple rather than build real per-user
authentication; the `APP_KEY` above is what protects the API itself from
random internet traffic, not from users of the app.

## Attachments (PDF uploads on goods receipts)

Uploaded PDFs are stored directly in Postgres and served back at
`/_blob/:id` — the exact URL the app's own code already expected. That
endpoint isn't behind the `APP_KEY` check (a plain link click can't send a
custom header), so it relies on the attachment id being an unguessable
random token. That matches how exposed these files already were inside the
original artifact.

## Local development

```bash
cp .env.example .env      # fill in DATABASE_URL and APP_KEY
npm install
npm start                 # http://localhost:3000
npm run migrate           # loads migrate/seed-data.json, once
```
