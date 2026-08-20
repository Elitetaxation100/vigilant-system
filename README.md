# Elite Taxation — Governance OS (real backend)

This is a real client-server app now: one Node.js server holds the data
(employees, tasks, activity log, punch clock), and every employee's browser
talks to that same server over the network. That's what actually fixes
"tasks assigned to someone don't reach them" — there's now exactly one
copy of the data, not one per browser.

## Running it locally (to try it out)

You need [Node.js](https://nodejs.org) installed (version 18 or newer).

```bash
cd server
npm install
npm start
```

Then open **http://localhost:3000** in a browser. That's the whole app —
frontend and backend are served from the same place.

The first time it runs, it creates `server/data/db.json` with these
starting accounts (this list is kept in sync with `server/db.js`'s
`ROSTER` — the single place these are defined):

| Name | Email | Password | Access |
|---|---|---|---|
| Shubham Sharma | shubham@elitetaxation.co.nz | Shubham@2026 | Superadmin |
| HR Administrator | hr@elitetaxation.co.nz | kajal11A@ | Superadmin |
| Parvinder Kumar | parvinder@elitetaxation.co.nz | Parvinder@2026 | Admin |
| Disha Chaudhary | disha@elitetaxation.co.nz | Disha@2026 | Admin |
| Vishal | vishal@elitetaxation.co.nz | Vishal@2026 | Admin |
| Ranjit Choudhary | ranjit@elitetaxation.co.nz | Ranjit@2026 | Employee |
| Suneha | suneha@elitetaxation.co.nz | Suneha@2026 | Employee |
| Anjana Pandey | anjana@elitetaxation.co.nz | Anjana@2026 | Employee |
| Mukul | mukul@elitetaxation.co.nz | Mukul@2026 | Employee |
| Khushi | khushi@elitetaxation.co.nz | Khushi@2026 | Employee |
| Diksha | diksha@elitetaxation.co.nz | Diksha@2026 | Employee |
| Nitish | nitish@elitetaxation.co.nz | Nitish@2026 | Employee |
| Smita | smita@elitetaxation.co.nz | Smita@2026 | Employee |
| Hunny | hunny@elitetaxation.co.nz | Hunny@2026 | Employee |
| Natasha | natasha@elitetaxation.co.nz | Natasha@2026 | Employee |
| Krishna | krishna@elitetaxation.co.nz | Krishna@2026 | Employee |

**Treat this table as sensitive** — these are real, working credentials for
real accounts, not placeholders. Don't push this repository (or this file)
anywhere outside your own private storage, and don't paste this table into
chat, email, or a shared doc. **Change every one of these passwords before
real use** — sign in as HR Administrator or Shubham (Superadmin) and use
Employee Directory → "Manage access" on each account. New passwords must be
at least 8 characters (enforced by the server, not just the UI). Sign-in is
also now rate-limited (20 attempts per 15 minutes per IP) to slow down
anyone guessing at the defaults above before you get to changing them.

## Making it reachable by your whole team

Running it on your own laptop only serves *your* laptop — for every
employee to reach the same server, it needs to run somewhere always-on
that everyone's computer can reach. Two realistic paths:

**A. A small always-on server you already have** (an office PC that stays
on, a NAS, an existing company server): copy this `server/` folder onto
it, run `npm install && npm start` there, and have everyone open
`http://<that machine's address>:3000` on the office network. This is
free and keeps everything in-house.

**B. A hosting provider** (recommended if you want it reachable outside
the office too, e.g. from home): services like Render, Railway, or
Fly.io can run a Node app for you, usually with a free tier for something
this size. In broad strokes: create an account, connect this project
(or upload it), set the start command to `npm start`, and they give you
a public URL. **Important:** whichever you pick, make sure it gives your
app **persistent disk storage** for the `server/data/` folder — some
free tiers wipe the filesystem on every restart, which would erase your
tasks and employee accounts. If you're not sure which option handles
this correctly, that's worth asking the provider directly, or getting a
developer to set it up once — after that it just runs.

**Deploying on Replit specifically:** this repo includes a `.replit` file
so Replit picks up `npm start` automatically — `engines.node` in
`package.json` also documents the Node version it needs. The one thing to
get right is the deployment type: pick **Reserved VM ("Always On")**, not
**Autoscale**. Autoscale runs on ephemeral storage per instance, and this
app's entire database — every employee, task, and the session-signing
secret — is the one file `server/data/db.json` on local disk. On
Autoscale, a scale event or redeploy can wipe that file (and silently log
everyone out, since the signing secret goes with it). A Reserved VM keeps
the same disk across restarts, which is what this app needs.

## Security notes (read before real use)

- Passwords are hashed (bcrypt) — a real improvement over the old
  plaintext-in-the-file-source setup. Change the default passwords above.
- Sessions are JWTs signed with a secret that's generated once and saved
  to `server/data/jwt-secret.txt`. Keep that file private; anyone with it
  could forge sessions. In production, prefer setting it yourself via an
  environment variable: `JWT_SECRET=<random long string>`.
- There's no HTTPS built in. If this is reachable over the open internet
  (not just your office network), put it behind a reverse proxy (e.g.
  Caddy, Nginx, or your hosting provider's built-in HTTPS) so passwords
  and pause-task screenshots aren't sent in the clear.
- Back up `server/data/db.json` periodically — it's the entire database.
- The API allows requests from any origin by default. Once you have a
  real deployed URL, set `ALLOWED_ORIGIN=https://your-app-domain` so only
  your own frontend can call the API.
- All task/client/employee names and notes shown in the UI are HTML-escaped
  before display, and login is rate-limited — this closes off a class of
  issue where one person's display name or task title could otherwise run
  as code in someone else's browser.
- Admin actions on an existing task (review, reassign, approve/reject a
  proposed window) are scoped to the admin's own team (`managesIds`), the
  same boundary already used when handing out new work — one admin can't
  reach into another manager's tasks.

## What changed from the static-file version

- All data lives on the server (`server/data/db.json`), not in the
  browser — this is the actual fix for cross-employee sync.
- Login is real: hashed passwords, server-issued session tokens, and
  every permission check (who can assign to whom, who can approve a
  proposed window, who can see the Employee Directory) is enforced on
  the server, not just hidden in the UI.
- The task timer is server-authoritative: elapsed hours are computed
  from server timestamps, not trusted from the browser.
- The punch clock is server-authoritative too, for the same reason.
