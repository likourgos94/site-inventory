# Site Inventory / Lagerbestand

A small web app for the iPhone that shows what material is in the warehouse (Lager) and lets you change the stock quickly.

Built for FTTx site management (project LAHLU01, Lahnau).

## What it does

- **Material list** grouped by category, with search and a filter for items below minimum stock
- **New material**: item number (automatic, e.g. `MAT-0001`), name, category, unit, starting stock, optional minimum stock, note
- On each material, four buttons:
  - **Wareneingang / Arrival**: adds to stock
  - **Ausgabe an Team / Issue to team**: takes from stock (team name is remembered)
  - **Umlagerung / Transfer**: in or out, to or from another warehouse or project
  - **Bestand setzen / Set amount**: type the counted number directly
- Items below their minimum stock turn red
- **Export Excel**: an `.xlsx` file with all materials and amounts, opened in the iPhone share sheet (Mail, WhatsApp, Save to Files)
- Saves on the phone and works without signal. No history is kept: only the current amount and the last change.

## Plan

1. Material list, the four actions, Excel export ✅
2. Send the stock to Smartsheet (one row per material)
3. Login, so only you can change stock
4. Later: teams request material, you approve, and it is issued to that team

## Put it online (Cloudflare, one time)

1. Log in at dash.cloudflare.com.
2. Go to **Workers & Pages** → **Create** → **Import a repository**.
3. Pick the GitHub repository `site-inventory`.
4. Leave the settings as they are (deploy command `npx wrangler deploy`) and tap **Deploy**.
5. You get an address like `https://site-inventory.<your-name>.workers.dev`.

From then on, every change on the `main` branch goes online automatically.

## Install on the iPhone

1. Open the address in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**.
3. Open it from the home screen icon. Tap ⚙︎ to set the warehouse name, teams, categories and units.

The stock is stored only on this iPhone until step 2 (Smartsheet) is built. Deleting the app icon deletes it, so export to Excel regularly as a backup.

## Files

| File | What it is |
|---|---|
| `public/index.html` | The screens |
| `public/app.js` | The app logic |
| `public/xlsx.js` | Makes the Excel file (small, no library needed) |
| `public/style.css` | Colors and layout |
| `public/sw.js` | Offline support. Raise the `CACHE` version after changes |
| `src/index.js` | Cloudflare Worker, used for Smartsheet later |
| `wrangler.jsonc` | Cloudflare settings |

## Try it on a computer

```
npm install
npm run dev
```

Then open http://localhost:8787.
