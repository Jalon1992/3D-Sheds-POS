# Going live: your own production instance

This sets up a real, permanent copy of the shed builder, CRM and point of sale for your business, with your own web address, logins, contracts, texts and email. Plan on about an hour, plus a few days' wait for text-message registration (step 6).

You start with an empty system and a sample shed catalog. No other company's customers, contracts or settings are in this repo.

---

## 1. Get your own copy of the code
1. Sign in to GitHub and **fork** this repo, or import it as your own repository. You now have your own copy.
2. Use the **main** branch.

## 2. Host it on Railway (Hobby plan, about $5–8/month)
1. Go to **railway.com**, sign in with GitHub and choose the **Hobby** plan. The free plan is too small to build contract PDFs.
2. **New Project → Deploy from GitHub repo**, then pick your copy. Railway finds the `Dockerfile` and builds it.
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

   Optional, if you're setting this up for someone else:

   | Variable | Value |
   |---|---|
   | `MODULES` | which add-ons they start with: `all`, `none` (3D configurator only) or e.g. `crm,pos`, `pos,orders` |
   | `DEVOPS_EMAIL` / `DEVOPS_PASSWORD` | your developer login (password 10+ characters). Only it sees **Settings → Modules**, where you switch the CRM, Point of sale and Production & delivery on or off. Their admins can't see it or change it |

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
  - Pick your provider (Gmail / Google Workspace, Microsoft 365, or other SMTP) and enter the login.
  - Gmail and Microsoft need an *app password*; the help box explains how to get one.
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
- **GoHighLevel:** push every new quote to your GHL account as a contact, opportunity and note.
- **Webhooks:** send quotes to Zapier, Make or your own systems.
- **API keys:** let your website or other tools read and create quotes (docs at `/docs`).

## 9. Backups
Everything lives in the volume at `/app/data`: database, contracts, signed PDFs and uploads.
- Turn on backups for that volume in Railway if your plan offers them, and check now and then that they're running.
- Before big changes (updating the code, editing many prices), make a backup first.

## 10. Getting updates later
If this repo gets improvements, open your fork on GitHub and click **Sync fork**. Railway then redeploys on its own. Your data is untouched, because it lives in the volume, not in the code.

---

**Something not working?** The **Settings → CRM & messaging** cards explain text/email problems in plain words. The `/healthz` address should say `{"ok":true}` when the app is running.
