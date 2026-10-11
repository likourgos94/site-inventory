# Site Inventory / Lagerbestand

A small web app for the iPhone that shows what material is in the warehouse (Lager) and lets you change the stock quickly.

Built for FTTx site management (project LAHLU01, Lahnau).

## What it does

- **Material list** grouped by category, with search and a filter for items below minimum stock
- **New material**: start typing a name, Netceed number or UGG code and pick from the built-in catalog (UGG / Netceed materials). Item no., UGG code, name, category and unit are filled in. Other materials get an automatic number (e.g. `MAT-0001`).
- On each material, four buttons:
  - **Wareneingang / Arrival**: adds to stock
  - **Ausgabe an Team / Issue to team**: takes from stock (team name is remembered)
  - **Umlagerung / Transfer**: in or out, to or from another warehouse or project
  - **Bestand setzen / Set amount**: type the counted number directly
- **Zählen / Count** (stock-taking): on a material, tap standard amounts (+1, +5, +10, +50, +100, set your own in ⚙︎) and type any other amount; the app adds them up and shows the difference to the stock. Materials with a pack size in the name (e.g. `VPE=6000m`) also get a "+1 VPE" button. **Save** makes the total the new stock; **Save & next** goes straight to the next material in the list. An unfinished count is kept if the app is closed.
- Items below their minimum stock turn red
- **Export Excel**: an `.xlsx` file with all materials and amounts, opened in the iPhone share sheet (Mail, WhatsApp, Save to Files)
- Saves on the phone and works without signal.
- **Verlauf / History**: every change in one list, newest first: arrivals, issues, transfers, counted amounts, new / edited / deleted materials, and team requests (received, approved, denied). Filter by kind, search by material, team or request number, or open it from a material to see only that material. Also copied to the Smartsheet sheet *Verlauf – History* (one row per change).
- **Lock screen**: the warehouse app only opens on a phone with your PIN (APP_PIN). Anyone else sees "Manager only" and a button to the teams' request page. If you change APP_PIN in Cloudflare, every phone with the old PIN is locked until the new one is typed.
- **Smartsheet**: after every change the stock is sent to the sheet *Lagerbestand – Inventory* (one row per material). Without signal it is sent as soon as the phone is online again. The app creates the sheet itself the first time.

- **Team requests**: teams open `/request.html`, sign in with the team code, pick materials and amounts and send a request. You see open requests under **Anforderungen / Requests**, can lower amounts, and approve or deny. Approving takes the approved amounts out of stock as "Issue to team". Requests are kept in the Smartsheet sheet *Anforderungen – Requests* (one row per requested material), and teams see whether theirs was approved.

## Plan

1. Material list, the four actions, Excel export ✅
2. Send the stock to Smartsheet (one row per material), protected by a PIN ✅
3. Material catalog with suggestions ✅
4. Team requests with approve / deny ✅
5. History of all changes, lock screen ✅
6. Count (stock-taking) with standard amounts ✅

## Put it online (Cloudflare, one time)

1. Log in at dash.cloudflare.com.
2. Go to **Workers & Pages** → **Create** → **Import a repository**.
3. Pick the GitHub repository `site-inventory`.
4. Leave the settings as they are (deploy command `npx wrangler deploy`) and tap **Deploy**.
5. You get an address like `https://site-inventory.<your-name>.workers.dev`.

From then on, every change on the `main` branch goes online automatically.

## Connect Smartsheet (one time)

1. In Smartsheet: profile picture → **Personal Settings** → **API Access** → **Generate new access token**. Copy it.
2. In Cloudflare: **Workers & Pages** → **site-inventory** → **Settings** → **Variables and Secrets** → **Add**:
   - Type **Secret**, name `SMARTSHEET_TOKEN`, value = the token
   - Type **Secret**, name `APP_PIN`, value = a PIN you choose
   - Type **Secret**, name `TEAM_PIN`, value = a code for the teams (different from your PIN)
3. Open the app and type the same PIN on the lock screen. Use a long PIN, like a password (10 or more letters and numbers): a short number could be guessed by trying.
4. In the app: ⚙︎ → **Team requests** → **Share link**, and send the link and the team code to the teams.

Works with US (app.smartsheet.com) and EU (app.smartsheet.eu) Smartsheet accounts; the Worker finds the right one by itself.

If the app says **Token ungültig / Token invalid**: make a new token in Smartsheet (step 1), then in Cloudflare edit `SMARTSHEET_TOKEN` and paste only the token (no spaces, no quotes). Saving it redeploys the Worker; then tap **Jetzt senden / Send now**.

Tip: in Smartsheet, open *Anforderungen – Requests* → **Automation** → *When rows are added* → *Alert someone* to get an email or push message for each new request.

The sheet always follows the phone: changes typed into the stock columns in Smartsheet are overwritten by the next change on the phone. Rows you add by hand in Smartsheet are left alone. Don't edit the *App-ID* column.

## Install on the iPhone

1. Open the address in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**.
3. Open it from the home screen icon. Tap ⚙︎ to set the warehouse name, teams, categories and units.

The stock is stored on this iPhone, with a copy in Smartsheet. Deleting the app icon deletes the phone's copy, so export to Excel now and then as a backup.

## Files

| File | What it is |
|---|---|
| `public/index.html` | The screens |
| `public/app.js` | The app logic |
| `public/request.html`, `public/request.js` | The request page for the teams |
| `public/catalog.js` | The material catalog for the suggestions. Copy a line to add a material |
| `public/xlsx.js` | Makes the Excel file (small, no library needed) |
| `public/style.css` | Colors and layout |
| `public/sw.js` | Offline support. Raise the `CACHE` version after changes |
| `src/index.js` | Cloudflare Worker: checks the PIN / team code and reads and writes the Smartsheet sheets |
| `wrangler.jsonc` | Cloudflare settings |

## Try it on a computer

```
npm install
npm run dev
```

Then open http://localhost:8787.
