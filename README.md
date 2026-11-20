# Office Manager

A self-hosted web app for a ~45-person office. Eight sections:

| Section | What it does |
|---|---|
| **Replenish** | Staff request supplies (drinks, toilet paper, coffee beans, bond paper, staples…). "Me too" votes avoid duplicates; admins move requests through Requested → Ordered → Delivered. |
| **Rooms** | Book meeting rooms on a day timeline. Overlapping bookings are refused by the server, even when two people click at the same moment. |
| **Parking** | Book slots for yourself, a guest or a VIP, with the same no-double-booking guarantee. |
| **Library** | Books, board games and consoles with cover art. Borrow/return, due dates, a limit of 5 open loans per person. |
| **Events** | Announce community events with artwork upload and RSVP. |
| **Promos** | Employee-purchase offers with a posted price (and optional regular price → "% off"). No online payment. |
| **Community Board** | Holidays, notices and repairs with photos. Birthdays and work anniversaries appear automatically from people's records. |
| **Attendance** | Clock in/out with a selfie, GPS and a server timestamp. Outside the office radius, the server refuses. |

## Requirements

- Node.js 22.13 or newer (it uses the built-in `node:sqlite`), or Docker.
- **HTTPS.** Phone browsers only allow the camera and GPS on `https://` pages (or `localhost`). Attendance will not work over plain `http://` on the office network.

## Quick start (no Docker)

```bash
npm install
npm run create-admin -- you@company.com "Your Name"     # prints a temporary password
npm run seed-starter                                    # optional: placeholder rooms and parking slots P1–P10
npm start                                               # http://localhost:3000
```

Sign in, change the temporary password, then open **Admin**:

1. **Office and location** – set the office name, then the latitude/longitude and the radius (default 150 m). *Until this is set, clock-in is refused with "geofence not configured".* Tip: stand in the office, open a map app and copy the coordinates. Accuracy limit defaults to 100 m.
2. **Rooms and parking** – rename or add your real rooms and slots.
3. **People** – add staff one by one, or paste a CSV. Columns (header row required): `name, email, title, birthday, hired_on, role`. Birthday is `MM-DD`, hired_on is `YYYY-MM-DD`, role is `member` or `admin`. Each new person gets a temporary password that must be changed at first sign-in.
4. **Supplies** – edit the catalog of things people can request.
5. Tick **can post** for anyone besides admins who should publish to the Board, Events and Promos.

## Deploying with HTTPS (Docker + Caddy)

1. Point a DNS name at your server and put it in `Caddyfile`.
2. `docker compose up -d --build`
3. Create the first admin: `docker compose exec app npm run create-admin -- you@company.com "Your Name"`

Caddy obtains and renews the certificate itself. Without Docker, run the app with `BEHIND_HTTPS=1 npm start` behind any reverse proxy that terminates HTTPS and forwards to port 3000 (this marks cookies Secure and trusts the proxy headers).

Environment variables: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (./data), `BEHIND_HTTPS` (1 behind a proxy).

### Hosts without a shell (Render, Railway, Fly…)

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (8+ characters) and optionally `ADMIN_NAME`. On start, if the app has no users at all, it creates that admin and asks for a new password at first sign-in. It never runs again once any user exists, so remove the variables after your first sign-in. Remember to mount a persistent disk at `/data`, or the database is wiped on every restart.

## Backups

Everything lives in the `data/` folder (SQLite database, uploaded artwork, private selfies). Stop the app or copy while it is idle, and back the whole folder up regularly. Selfies are attendance records of identifiable people: keep the backups private and follow your local data-privacy rules (in the Philippines, the Data Privacy Act; consider telling staff what is collected and for how long).

## Library covers

When an admin adds an item, the app can search Open Library (books) and Wikipedia (board games, consoles) for cover art and download the chosen picture to your server, so staff browsers never contact third-party sites. This needs outbound internet from the server. If a search finds nothing, upload your own photo.

## Security notes

- Passwords are hashed with scrypt; sessions are server-side; sign-in is rate-limited; writes check the request Origin.
- Selfies are stored outside the public folder and shown only to the person who took them and to admins.
- Attendance checks (location, accuracy, time) happen on the server. The clock is the server's, not the phone's.
- **Limit you should know about:** a determined person can fake GPS on their own phone, and no web app can fully prevent that. The selfie plus the admin's daily roster is the practical second check.

## Tests

`npm test` runs 18 backend tests (double-booking including parallel requests, geofence, roles, uploads, loans).
