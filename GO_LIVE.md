# Going live: adding a company

Every company runs the same code from **this one repo**, each in its **own Railway service with its own volume**, so their data never mixes and one merge updates them all. This guide adds one company: its own web address, logins, contracts, texts and email. Plan on about an hour, plus a few days' wait for text-message registration (step 6).

A new company starts with an empty system and a sample shed catalog. No other company's customers, contracts or settings are in this repo. Companies differ only in their hosting settings (modules, domain, logins). There are no per-company code copies to keep in sync. How updates reach them: [RELEASES.md](RELEASES.md).

---

## 1. Which branch
- **Every company:** deploy from **`stable`**.
- **Your own test install, plus one friendly company:** deploy from **`pilot`**. They get each update a day or two earlier.

Keep all the services in **your** Railway account, so you control updates, and bill companies for hosting.

## 2. Host it on Railway (Hobby plan, about $5–8/month)
1. Go to **railway.com**, sign in with GitHub and choose the **Hobby** plan. The free plan is too small to build contract PDFs.
2. **New Project → Deploy from GitHub repo** → pick this repo, then in the service's **Settings → Source** set the branch to **`stable`** (or `pilot`, see step 1). Railway finds the `Dockerfile` and builds it.
3. Before using it, add a **volume**. This is where every customer, quote, contract and signed PDF is kept.
   - Right-click the service → **Attach volume** → mount path **`/app/data`**.
   - Without a volume, everything is erased each time the app redeploys.
4. Open the service's **Variables** tab and add:

   | Variable | Value |
   |---|---|
   | `ADMIN_EMAIL` | the email you'll log in with |
   | `ADMIN_PASSWORD` | a strong password, 12+ characters (you can change it later in Account) |
   | `UPLOAD_DIR` | `/app/data/uploads` |
   | `COOKIE_SECURE` | `true` (optional: it's automatic on https) |
   | `SESSION_SECRET` | a long random string, e.g. 40+ random letters and numbers |
   | `MODULES` | which add-ons this company gets on the first start: `all`, `none` (3D configurator only) or e.g. `crm,pos`, `pos,orders` |
   | `DEVOPS_EMAIL` / `DEVOPS_PASSWORD` | **your** developer login (password 10+ characters), the same on every company. Only it sees **Modules** and **System & backups**; the company's admins can't see it or change it |
   | `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | where off-server backups go (step 9). The same bucket can serve every company: each company gets its own folder |
   | `BACKUP_S3_PREFIX` | that company's folder in the bucket, e.g. `trimline-barns` (defaults to its company name) |

   Do **not** add `MESSAGING_TEST_MODE`. That setting only logs texts and emails instead of sending them.
5. Keep it at **1 replica**. The included `railway.json` already does this; two copies would each get a separate database.
6. **Settings → Networking → Generate Domain** gives you a `…up.railway.app` address. Open `https://<that address>/admin/` and log in.

## 3. Use your own web address (recommended)
1. In Railway: **Settings → Networking → Custom Domain**, then enter e.g. `builder.yourcompany.com`.
2. At your domain provider (GoDaddy, Namecheap, Cloudflare…), add the **CNAME** record Railway shows you. It usually works within an hour.
3. In the admin: **Settings → Company → Public URL**, then enter `https://builder.yourcompany.com` and save.
   **Signing links, texts and emails use this address**, so set it before sending any contracts.

## 4. Company and configurator setup
- **Settings → Company:** company name, phone, address, logo, brand color, time zone.
- **3D configurator:**
  - **Styles & sizes, Roofing & colors, Options & 3D models:** replace the sample catalog with your buildings and prices.
  - **Price tiers & dealers:** add your lots, if you have more than one.
  - **Configurator settings:** tax rate, delivery fee, whether customers see prices, whether a phone number is required, the quote form wording.
- Put the customer configurator on your website. Link to `https://builder.yourcompany.com/`, or embed it with an iframe of the same address plus `?embed=1`.

## 5. Point of sale and contracts
1. Save your **Cash** and **Rent-to-Own** contracts as PDFs (from Word or Google Docs: File → Download → PDF).
2. **Point of sale → Contract templates → + Upload template.** Then drag on the signature, initials, date and auto-filled boxes (name, address, price, RTO payment…). Delete the two *Sample* templates when yours are ready.
3. **Settings → Point of sale settings:**
   - Enter your **RTO company's real rate sheet** (term factors). The defaults are placeholders.
   - Set your cash deposit %, how long signing links last, and the wording of contract texts and emails.
4. Do one full test sale to yourself (your own phone and email) before using it with customers.

## 6. Texts and email (so links and alerts really send)
Go to **Settings → CRM & messaging**.
- **Email:**
  - **On Railway Free/Hobby, use Resend, Postmark or SendGrid.** Railway blocks outgoing email-server (SMTP) connections on those plans, so Gmail, Microsoft 365 and other SMTP logins time out there. These three services send over normal web traffic instead.
    - Resend is the simplest: sign up free, add your company domain under **Domains** (it can add the DNS records to Cloudflare for you), create an API key, and paste it in. Then set the **From email** to an address on that domain, such as sales@yourcompany.com.
  - On a host that allows SMTP (Railway Pro, your own server), you can instead pick Gmail / Google Workspace, Microsoft 365 or another SMTP server and enter the login. Gmail and Microsoft need an *app password*; the help box explains how to get one.
  - Click **Check connection**, then **Send a test**.
  - Click **Check connection**, then **Send a test**.
- **Texts:** choose one.
  - **GoHighLevel:** if your GHL number already texts customers.
  - **Twilio:** paste the Account SID, Auth Token and number. Click **Check connection**, then **Connect replies for me**.
    - **Before carriers will deliver your texts, register the number for A2P 10DLC in Twilio** (Messaging → Regulatory compliance). Approval usually takes a few days. Until then texts may be blocked, though email and in-person signing work fine.
- **Alerts:** add the phone numbers and emails that should hear about new leads and signed contracts.

## 7. Staff logins
**Account & users → Add user.** Give each person their own login and role:
- **Admin:** everything.
- **Sales:** CRM, quotes, contracts (can be tied to one dealer lot).
- **Production:** the build board and drawings.
- **Delivery:** the delivery schedule.

Everyone can be logged in at the same time.

## 8. Optional integrations
**Settings → Integrations & API:**
- **GoHighLevel:** push every new quote to your GHL account as a contact, opportunity and note. It also sends the **quote PDF with pricing** (a pricing page plus the 3D view, floor plan and elevations), stored in GHL Media and linked on the contact and opportunity. Give the Private Integration token the `medias.write` scope.
  - Also add `opportunities.readonly`, `users.readonly` and `locations/customFields.readonly`. With those, **Integrations → GoHighLevel** loads your pipelines, stages, users and custom fields as dropdowns.
  - In those dropdowns, pick the pipeline, stage, owner (and an owner per dealer lot), forecast close date and probability, and the opportunity name pattern.
  - Then choose which quote value fills each custom field, such as Quote PDF link, size, style, total or 3D link.
- **Webhooks:** send quotes to Zapier, Make or your own systems.
- **API keys:** let your website or other tools read and create quotes (docs at `/docs`).

## 9. Backups (automatic)
Everything lives in the volume at `/app/data`: database, uploaded models and images, contract templates, signed contracts.

The app backs itself up:
- **Every day** at 3 am in the company's time zone. Change the hour with `BACKUP_HOUR`.
- **Before every update.** The database is copied before any table changes run, so an update can always be undone with the data as it was.
- Backups are kept on the volume: the newest 7, or 3 when off-server copies are on. Set the number with `BACKUP_KEEP`.

**Copy them off the server.** If the volume is ever lost, local backups go with it. Create a bucket at any S3-compatible service and add the four `BACKUP_S3_…` variables from step 2:
- Cloudflare R2: no download fees. Its endpoint looks like `https://<account-id>.r2.cloudflarestorage.com`.
- Backblaze B2, AWS S3 or Wasabi also work.
- On the bucket, add a lifecycle rule that deletes files after 30–90 days.

**Check them:** log in with the developer login → **Settings → System & backups**. It shows:
- the version the company runs
- the last backup, and whether it reached the bucket
- every backup file, with **Download**

**Back up now** makes one on demand.

**Restore:**
1. Download the backup and unpack it: `tar -xzf backup-….tar.gz`.
2. In Railway, open the service → **Volume**.
3. Stop the service, or set it to 0 replicas.
4. Replace `shedbuilder.db` and the `uploads` and `files` folders on the volume with the ones from the backup.
5. Start the service again.

A *pre-update* backup is just the database file: put it in as `shedbuilder.db`.

## 10. Updates
You don't do anything per company. When you merge a release into `stable`, every company's service redeploys on its own. The steps, the pilot group and how to undo a bad release are in [RELEASES.md](RELEASES.md). Data is untouched, because it lives in the volume, not in the code.

---

**Something not working?**
- Text or email problems: the **Settings → CRM & messaging** cards explain them in plain words.
- Is the install healthy? `https://<company address>/healthz` shows:
  - `"ok": true` when the app is running, the database works and logins can work
  - the `version` and `commit` it runs
  - when the last backup was made
