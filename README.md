# 3D Shed Builder

A self-hosted 3D shed configurator with a **built-in CRM**, a **point of sale with e-signatures** (Cash and Rent-to-Own), **production & delivery boards**, an admin back office, an Open REST API, signed webhooks and a native GoHighLevel integration.

**Setting up your own live copy?** Follow [GO_LIVE.md](GO_LIVE.md).

**New in 2.0** — see [Point of sale](#point-of-sale-contracts--e-signature), [CRM](#crm), [Texting & email](#texting--email-setup), [Team roles](#team-roles--drawing-packages) and [Testing](#testing).
- Every 3D submission lands in the CRM as a contact + deal. Add walk-ins and phone leads by hand. Two-way texting and email, notes, tasks, saved replies, a drag-and-drop pipeline, and live updates for everyone signed in.
- Upload your own contract PDFs for **Cash** and **Rent-to-Own**, drag signature / initials / date / auto-filled boxes onto them, and the 3D rendering, floor plan and all four elevations are attached automatically.
- Send the contract by **text and/or email**, or sign in person on the lot tablet. You get a text/email the moment it's signed, and you download one PDF with everything: contract, signatures, drawings and a certificate of completion (audit trail).
- Signed contracts drop onto the **Production & delivery** board. Roles: **Admin, Sales, Production, Delivery**, all logged in at the same time.

- **Customers:** pick a Style & Size (one screen) → Roof & Colors (Architectural Shingles or Ag Panel Metal) → Options → submit a Quote. Standard options are already on the shed. Customers **drag and drop** doors, windows and every other option to a new spot on the 3D model (along a wall, around a corner to another wall, across the ceiling), and click any of them to upgrade, swap or remove it. After submitting they can download their **3D model (.glb)** and a **to-scale floor plan** (SVG / print to PDF).
- **You (admin):** log in at `/admin` to manage styles, sizes & prices, colors, options (each with a built-in 3D model or your own uploaded `.glb`), quotes, GHL, webhooks, API keys and branding — with a live 3D preview while you edit.
- **Integrations:** every quote can go to GoHighLevel (contact + opportunity + note, or a workflow Inbound Webhook), to any number of webhooks (Zapier, Make, n8n, your server), and everything is available through a documented REST API (`/docs`).

---

## Quick start

Requires **Node.js 22.13 or newer** (uses Node's built-in SQLite — no database server to install).

```bash
npm install
ADMIN_EMAIL=you@yourcompany.com ADMIN_PASSWORD='pick-a-strong-one' npm start
```

Open:

| | |
|---|---|
| Configurator | http://localhost:3000/ |
| Admin | http://localhost:3000/admin/ |
| API docs (Swagger) | http://localhost:3000/docs |

The first run seeds 4 sample styles (Classic Gable, Lofted Barn, Modern Lean-To, Garage), sizes, colors and ~25 options so you can see everything working. Edit or delete them in the admin.

> If you don't set `ADMIN_EMAIL`/`ADMIN_PASSWORD` the login is `admin@example.com` / `changeme123` — change it right away in **Admin → Account & users**.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | First admin login (only used on the very first run) |
| `DB_PATH` | `./data/shedbuilder.db` | SQLite database file |
| `UPLOAD_DIR` | `./uploads` | Uploaded 3D models and images |
| `SESSION_SECRET` | auto-generated | Cookie signing secret |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `FILES_DIR` | `<DB folder>/files` | Contract templates and signed contracts (kept private — never served publicly) |
| `MESSAGING_TEST_MODE` | — | `1` = log texts/emails in the CRM without sending them (also a switch in Settings → CRM & messaging) |

**Back up `data/` and `uploads/`** — that's everything (catalog, quotes, CRM, contracts and signed PDFs in `data/files`, settings, models).

---

## Deploying

Any host that runs Node or Docker works. It needs a **persistent disk** for `data/` and `uploads/`.

**Render (easiest, uses the included `render.yaml`)**
1. On render.com: **New → Blueprint**, connect GitHub and pick this repo.
2. Enter `ADMIN_EMAIL` and `ADMIN_PASSWORD` when asked, then **Apply**. Render creates the web service with a 1 GB disk (Starter plan; disks need a paid instance).
3. When it's live, open `https://<your-app>.onrender.com/admin/`, log in, and set **Settings → Company → Public URL**.
4. Optional: add your own domain (e.g. `builder.yourcompany.com`) under the service's **Settings → Custom Domains**.

**Docker**
```bash
docker build -t shed-builder .
docker run -d -p 3000:3000 -v shed_data:/app/data -v shed_uploads:/app/uploads \
  -e ADMIN_EMAIL=you@co.com -e ADMIN_PASSWORD='…' -e COOKIE_SECURE=true shed-builder
```

**Render / Railway / Fly.io:** create a Node (or Docker) web service from this folder, add a persistent volume mounted at `/app/data` (and one for `/app/uploads`, or set `UPLOAD_DIR` inside the same volume, e.g. `/app/data/uploads`), set the env vars above, start command `npm start`.

**VPS:** `npm install --omit=dev && npm start` behind Nginx/Caddy with HTTPS, kept alive with pm2 or systemd.

After deploying, set **Admin → Settings → Company → Public URL** (e.g. `https://builder.yourdomain.com`) so links in webhooks and GHL point to the right place.

---

## Managing the catalog

### Styles & sizes
Each style sets the **roof** (gable, barn/gambrel, lean-to, saltbox), which side faces front (gable end or long eave side), wall height, **roof pitch** (gambrel: separate **lower and upper pitch** and the **lower section length in feet** along the slope; saltbox: **long- and short-slope pitches**; the editor shows each section's pitch and length live), **eave overhang** and **gable overhang** (set separately), **siding** (LP SmartSide panel with 8" o.c. grooves and a painted, lightly embossed finish — the default — plus lap, board & batten, smooth T1-11 or metal), **wood trim** (LP SmartSide cedar-texture trim or smooth; metal trim is always smooth), the standard roofing and the roofing choices, a **roof edge style** (wide metal rake trim in the roof color, or a trim-color rake board + fascia capped with a thin metal rake edge and drip edge — sizes and metal color adjustable), and **trim sizes in inches**: fascia height (trim color), shingle rake board height (trim color), metal rake trim height and leg (roof color), corner board width, door & window trim width. The editor shows a live 3D preview.

- **Sizes:** width × depth with a base price each. Use *Fill prices* to set every size from a $/sq ft + base amount, then tweak.
- **Standard options:** items already on the shed and included in the base price (e.g. a 36" door on the front). Pick the option, the wall and an offset in feet from the wall's centre (viewed from outside, + is right). Optional **width/height** columns resize a door or window for just that style; leave them blank to use the option's own size. Customers who swap a standard item pay only the difference.
- **Options offered on this style:** untick anything the style shouldn't offer (e.g. no lofts on the garage). Customers only see the ticked options, switching styles drops items the new style doesn't offer, and the server enforces it on every quote. The style's standard options are always included.
- **Default colors** per style.

**Phones, tablets & computers:** the builder adapts to the screen. On computers the 3D view sits beside the panel. On phones and tablets held upright, the 3D view stays pinned at the top while the customer scrolls the options. On phones held sideways, the 3D view and the panel sit side by side. Touch screens get bigger buttons, plus tap to select, press-and-drag to move and pinch to zoom. Form fields stay at 16px so iPhones don't zoom in. The admin works on phones and tablets too: the menu scrolls across the top, wide tables scroll sideways, and editors open full-screen.

**Roof trim rules:** shingle roofs get no metal trim at all: shingle ridge caps, shingles lapping over the gambrel break, and a trim-color rake board (no metal rake edge or drip edge). Metal roofs are modelled as real **Ag Panel** (3/4" trapezoid ribs every 9" with two stiffening ribs between, screw rows every 2 ft, painted-steel finish). They keep the metal ridge cap, transition trim and rake trim. The ridge cap goes on last: it sits on top of the rake trim and runs out over its ends.

**Fly rafter (rake) tail cut — per style:** *Flat* cuts the rake tails level with the bottom of the fascia, so no point hangs below it (best on the steep hips of a Lofted Barn). *Plumb* is a vertical cut in line with the fascia face. Leave it on *Default* for flat on barns and plumb on everything else. The elevation drawings follow the same setting.

**Lofted Barn hip lengths:** set the **hip (lower section) length** and, optionally, the **upper section length** (both measured along the slope, without overhang). With only the hip length set, the upper pitch decides the upper section. With both set, the upper pitch is worked out to match. Both can be overridden **per size** in the size table (*Hip len / Upper len* columns). The roof readout shows each section's actual pitch and length for the previewed size.

### Roofing (Architectural Shingles / Ag Panel Metal)
Admin → **Roofing & colors → Roofing materials**: rename, describe and price each roofing type: per sq ft of **roof surface** (calculated from pitch and overhangs), per sq ft of floor, or flat. On each style choose the **standard roofing** (included in the base price) and which roofing types customers can pick; picking a different one charges the difference. Each roof color can be limited to shingles or metal (e.g. Galvalume only shows for Ag Panel).

### Colors
Siding, trim, roof, door and **window** colors (window color = the window frame and grids; the trim around windows always matches the trim color), each with an optional upcharge. A door or window color named **“Match Trim”** automatically follows the trim color. Each color group has a **“Customers can choose”** switch; turn it off and customers no longer see that choice (the style's default color is used, and the server enforces it).

### Options & 3D models
Every option has a category, price, size and a **placement**:

| Placement | Used for |
|---|---|
| `opening` | Doors, windows, vents — cuts a real hole in the wall |
| `wall_exterior` | Flower boxes, exterior lights |
| `wall_interior` | Shelves, workbenches, outlets |
| `ceiling` | Lights |
| `loft` | Lofts — spans the full wall it's on |
| `ground` | Ramps in front of a wall |
| `roof` | Cupolas on the ridge |
| `none` | Line items / toggles with no 3D (electrical package, insulation, anchors…) |

**Pricing units:** each, per ft of the wall it's on, per ft of width/depth/perimeter, or per sq ft of floor.

**Door & window sizes:** each option's width × height is set in its editor with a live preview; per-style sizes can be overridden in the style's standard options.

**Standard window heights:** Options → Windows has a *Standard window heights* table. For each window type, enter the bottom or the top in inches above the floor (the other follows). The option editor shows the same as *Standard height*, with the top and head-trim heights worked out for you.

**Gable windows:** each window/vent has *Can it go up in the gable?*: **No** (walls only), **Yes** (the customer gets *On the wall / Up in the gable* buttons when it's on a gable end) or **Gable only**. Up in the gable, the window is centred between the top of the wall and the rake. If it's too tall for that gable, the customer is told so and it stays put. Standard options have an *In gable* tick too. A sample *Gable Window (24" × 16")* is included.

**No overlaps:** doors, windows and everything else on a wall can't overlap, **trim included**: door/window casings, sills and shutters are counted, and openings stay clear of the corner boards. Dragging stops at the last free spot. When something can't fit (adding it, swapping to something bigger, moving it to another wall, putting it in the gable, or a size change that leaves no room), the customer gets a **pop-up saying there's no room** and what to try. The server applies the same rules to every quote and price request, including ones sent through the API.

**Swap group:** options with the same swap group (e.g. `door`, `window`) appear as upgrade choices when the customer clicks that item on the model.

**3D models — uploading & updating:** Admin → **Options & 3D models**. Every option with a 3D model has **Upload .glb / Replace .glb** and **Download** buttons right in the list, plus a *3D model* section at the top of its editor. To change a model:
1. Click **Download** to get the current model (the built-in one, or your last upload) as a `.glb` starting file.
2. Edit it in Blender, SketchUp or similar. Front facing **+Z**, **Y** up, sitting on the ground.
3. Click **Upload .glb** (or drag the file onto the upload box in the editor). It replaces the model everywhere right away, including in customers' 3D views, downloads and PDFs. Upload a new file any time to update it. *Use built-in instead* switches back.

Models are stretched to the width × height × depth you enter, so match those to the real product. Built-in models (single/glass/double/French/roll-up doors, windows, shutters, transoms, vents, flower box, lights, outlets, switch, breaker box, shelf, workbench, loft, ramp, cupola) take the customer's door/trim colors automatically.

**Packages (e.g. the Electrical Package):** any option can be a package. In its editor, under *What's in this package*, add items (breaker box, outlets, switches, lights, exterior lights…) with a **quantity**, the **wall** it goes on (front/back/left/right, ceiling, or auto), a **position** in feet from the wall centre (seen from outside, + = right; blank = we pick a free spot) and an optional **height**. When a customer adds the package, every item is placed on their shed at those spots, shown as *Included in the Electrical Package*, and priced in the package. If a spot is taken or the shed is too small, the item goes to the nearest free spot, and the customer is told if something doesn't fit at all. Customers can move package items but can't remove them on their own; removing the package removes them all. Tick *Only sold as part of a package* for parts like the breaker box so they aren't listed on their own. A package can also be a style's standard option. The floor plan shows electrical symbols (outlets, switches, ceiling lights, breaker panel) with a legend.


---

## Showing prices: customer vs dealer configurator

- **Customer-facing configurator** (your public link / website embed): Admin → 3D configurator → Configurator settings → **Show prices to customers**. When it's off, customers see no prices anywhere: no totals, no option prices, "Price on request" in the footer, and a *design* PDF without prices. Prices aren't even sent to their browser (the public catalog comes back with prices zeroed and the public price API refuses), so nobody can dig them out. Quotes are still priced on the server and sent to you, your webhooks and GHL with full pricing.
- **Dealer-facing configurator**: open the configurator while signed in to the admin (**Open configurator (dealer mode)**). It **always shows prices**, whatever the setting, and has a *Dealer mode* badge with a **Customer view** switch to preview exactly what customers see. Any staff login works (admin, sales, production). Sales/production users tied to a dealer lot are locked to that lot and its price tier. Quotes made this way are marked *Dealer configurator — name*, so you can tell them apart in Quotes.
- Give lot staff their own login (Account & users → role *Sales*, pick their lot) and have them sign in on the lot's tablet. The configurator then works as their dealer tool.

## Price tiers, dealer lots & ZIP pricing

Admin → **Price tiers & dealers**.

- **Pricing mode:** *Same price everywhere*, *By dealer lot*, or *By ZIP code*. Switch any time.
- **Four tiers.** Each tier has a name, an **adjust all prices %** (e.g. +8%), an optional **delivery fee**, and an optional **price sheet**:
  1. Click **Download price sheet** on a tier. It's a CSV listing every size, option, upcharged color and roofing type with its standard price.
  2. Fill in the last column with that tier's price (leave blank to use the % adjustment). Don't change the ID column.
  3. **Upload price sheet**, then **Save changes**.
- **Dealer lots:** add each lot (name, address, contact) and pick its tier. Customers choose their lot at the top of the builder. The copy button gives each lot its own builder link (`…/#dealer-lot1` or `?dealer=lot1`) that locks in that lot's pricing — use it on each lot's page or in GHL funnels.
- **ZIP codes:** assign tiers to exact ZIPs (`38301`), ranges (`38300-38399`) or prefixes (`383`). Add them one by one, paste a list (`ZIP,tier`), or upload a CSV. Exact beats range, range beats prefix; unlisted ZIPs use the **default tier**. Customers enter their ZIP at the top of the builder (or in the quote form).
- Prices are always recalculated on the server for the chosen lot/ZIP. Each quote stores the **dealer lot** and **price tier**; both appear in the admin, CSV export, webhooks (`dealer`, `pricing.tier`) and GoHighLevel (a `dealer: Lot name` tag, the note, and flat fields `dealer_name` / `price_tier`). The quotes API can filter by `?dealer=lot1`.

## Team roles & drawing packages

Admin → **Account & users** → add team members with a role. Any number of people can be signed in at the same time, on any device; pages update live when someone else changes something.

| Role | Can do |
|---|---|
| **Admin** | Everything, including templates, messaging setup, pipelines and users |
| **Sales** | CRM (contacts, conversations, pipeline, tasks), text & email customers, quotes, write up and send contracts, sign for the company |
| **Production** | Production board (move buildings through the shop, serial numbers, notes), quotes (read-only), drawings, signed contract PDF. No prices on the board |
| **Delivery** | Delivery schedule (date, time window, driver, notes), customer address/phone/directions, text the customer about their delivery, drawings |

Non-admin users can be limited to **one dealer lot** — they then only see that lot's quotes, contacts, contracts and orders (enforced by the server). Each person can switch on their own text/email alerts in **Account**. A login can be turned off without deleting it.

**Drawings (PDF)** — on any quote (list or detail) click **Drawings PDF** to get one file with:
1. 3D view & specifications (size, roofing, colors, dealer lot, delivery address, every option and its wall)
2. Floor plan (to scale)
3. Front & back elevations
4. Left & right elevations

Elevations are drawn to scale from the same geometry as the 3D model: siding, trim, roof profile and overhangs, every door/window/vent with its size, wall height and overall height.

**Quote PDF (prices + drawings)** — Admin and Sales also get a **Quote PDF** button. It is the same package with a **Quote & pricing** sheet added as sheet 2: customer contact, dealer lot, price tier, every line item (base shed, roofing, upgrades with "Upgrade from …", standard items marked *Included*, credits for removed standard items), subtotal, delivery, tax and total. The cover sheet also shows the total. Production only sees the Drawings PDF, which has no prices.

Customers can download their own Quote PDF from the thank-you screen after submitting. It does not show the tier name. You can turn this off in **Settings** ("Let customers download their quote PDF"), and the **Terms printed on the quote PDF** setting controls the fine print.

## Point of sale (contracts & e-signature)

Admin → **Point of sale**.

**1. Templates (one-time setup).** Make your agreement in Word or Google Docs, save it as PDF, then **Point of sale → Contract templates → + Upload template** and pick *Cash*, *Rent to own* or *Both*. In the designer, click a field type and click on the page:
- **Signer fields** — signature, initials, date signed, text box, checkbox — for the *Customer*, *Co-buyer* or *Company / sales rep* (blue / purple / orange).
- **Auto-filled info** — customer name/address/phone, building style/size/colors/options, every price line, deposit and balance, rent-to-own term/monthly/tax/LDW/due-at-signing/total of payments, contract #, date, dealer lot, sales rep, and **custom values** the rep types in (e.g. *Anchor type*).
- **3D rendering** and **floor plan** images placed right on your page.
- Template switches: **attach drawings** (3D view & specs, floor plan, 4 elevations appended at the end) and **customer initials on each drawing sheet**.
Drag to move, drag the corner to resize, arrow keys nudge, *Replace PDF* keeps your boxes. Two **Sample** templates are included so you can try everything immediately — they are examples only; have your attorney review your own agreement.

**2. Write it up.** From a contact, a quote (**Start contract**), the dealer configurator's thank-you screen (**Write it up**), or **+ New contract**: pick the design (or click **Design in 3D configurator** to build it now for this customer; see below), Cash or Rent to own, the template, the signers (optional co-buyer, which rep signs for the company), the deposit or RTO term (live monthly calculator; reps can override the monthly), and any custom values. The browser renders the 3D view, floor plan and elevations and the server builds the contract PDF. Nothing is sent until you review it.

**3. Sign.** **Send to customer** texts and/or emails each signer their own secure link (no account needed), or tap **Sign now (in person)** to sign on the lot tablet. The signing page works on phones: it walks the signer box by box, they draw or type a signature once and it's used everywhere, initial each drawing sheet, tick boxes, agree to e-sign (ESIGN/UETA consent) and finish. The rep taps **Sign as company**.

**4. Done.** When everyone has signed: the signed PDF (contract + signatures + drawings + **certificate of completion** with timestamps, IP addresses, devices and a SHA-256 fingerprint) is emailed to the customer, you get a text/email alert (Settings → CRM & messaging), the deal moves to **Sold**, the quote is marked won, and an order card lands on the **Production & delivery** board. Download the signed PDF any time from the contract page.

**Edit a sale & resend:** open the contract → **Edit & resend**. The wizard comes back filled in with everything used last time. Change the design (**Change design in 3D configurator**, see below), Cash ↔ Rent to own, template, signers, deposit or term, and add a short *What changed?* note. This creates the next version (`C-10012-R2`, `-R3`…). Every version is kept with its date and PDF, and the newest is marked **Latest**. Older versions' signing links stop working and point customers to the new link. The resent text and email say it's an updated contract. If the sale was already signed, the signed original stays on file and the order on the production board is updated (not duplicated) once the new version is signed. Deleting an unsent revision brings the previous version back as the latest.

Statuses: *Draft → Sent → Opened → Partly signed → Signed*, or *Void* (links stop working). Links expire after 30 days (configurable); resend any time.

**Design in 3D from the contract:** in a new or edited contract, **Design in 3D configurator** / **Change design in 3D configurator** opens the configurator in the same tab with a green bar: *Designing for (customer) · Save design & return · Cancel*. Make your changes and click **Save design & return**. The design is saved on that same customer (no new lead, no auto-reply to the customer; it's logged on their timeline and their deal is updated), and you land back on the contract with the new design loaded and everything you'd typed (sale type, signers, terms, notes) still there. With no customer picked yet, the configurator asks for a name plus an email or mobile before saving.

**Where things are in the menu:**
- *Point of sale → Contracts*: every contract, with **Edit** on each row to change a sale and resend it.
- *Point of sale → Contract templates*: upload your PDFs and place the signature/auto-fill boxes.
- *3D configurator → Configurator settings*: only what customers see in the builder (prices shown, tax, delivery fee, form and thank-you settings).
- *Settings → Company* (name, address, logo, time zone, public URL), *Settings → CRM & messaging* (texts, email, alerts), *Settings → Point of sale settings* (RTO rate sheet, deposits, signing links, contract messages).

**Rent-to-own setup:** Settings → *Point of sale settings*. Enter your RTO company's rate sheet as **term factors** (monthly rental = cash price before tax × factor ÷ months), the number of payments due at signing, damage-waiver (LDW) per month and the rental tax rate. The defaults are placeholders — replace them with your RTO company's numbers. The same page holds the default cash deposit %, link expiry and the wording of every contract text/email. Company name, address and the time zone used for dates on contracts are under Settings → Company.

## Dashboard reports

Admin → **Dashboard**. Sales, leads and quotes for **Month to date**, **Year to date**, any **Month**, any **Year**, or **All years**, with **Compare with last year** (same dates last year). Shows:
- **Tiles:** sales $ (cash vs rent-to-own count), leads, quotes, close rate (sales ÷ quotes) and average sale, each with the change against last year.
- **Month by month:** this year vs last year, switchable between sales $, sales count, leads, quotes and quoted $. Hover for exact numbers.
- **Running total:** by day for a month, by month for a year, with last year dashed for comparison.
- **Sales mix** (cash vs rent to own) and **where leads came from** (3D builder, walk-in/phone/manual, texts & emails).
- **Year-over-year** and **by-month** tables.
- A dealer-lot filter when you have lots.

A sale counts once, on the day its contract was first fully signed, at the value of its latest signed version. Dates use the time zone in Point of sale settings.

## CRM

Admin → **Contacts / Conversations / Pipeline / Tasks**.
- **Every 3D quote** creates or updates a contact (matched by email, then phone) and a deal in the *Sales* pipeline. A customer who designs again updates their open deal instead of piling up cards. Existing quotes from before 2.0 are imported once on first start.
- **Manual leads:** *+ Add lead* (walk-ins, phone calls, Facebook…), with duplicate detection.
- **Contact record:** contact details, tags, owner, consent and do-not-contact switches; one timeline with texts, emails, notes, calls, quotes, contracts and stage changes; send a **text or email** (saved replies and merge tags like `{{contact.first_name}}`); tasks; deals with stage/status; 3D designs; contracts.
- **Conversations:** a shared inbox. Replies arrive live (Twilio, GHL or inbound-email webhook). Customers who reply **STOP** are marked do-not-text automatically.
- **Pipeline:** drag-and-drop board with totals per stage; edit stage names/order (*Edit stages*). Sending a contract moves the deal to *Contract sent*; signing moves it to *Sold*.
- **Alerts:** the bell shows new leads, replies and signed contracts; optionally by text/email (Settings → CRM & messaging, or each user's Account).
- **Production & delivery:** *Sold → In production → Built → Delivery scheduled → Out for delivery → Delivered*. Production and Delivery each move cards through their own stages ("Built" is the hand-off). The delivery schedule lists dates, addresses (directions link), drivers and one-tap texts ("On the way", "Delivered").

## Texting & email setup

Admin → Settings → **CRM & messaging**. The two cards at the top show whether texting and email are **Ready**, the last message sent and the last reply received. Each card has **Check connection**, which logs in with your saved details without sending anything and lists what's fine (✓), what to fix (✕) and warnings (!), and **Send a test**.

**Texting.** Pick one:
- **Twilio.**
  1. Paste the Account SID and Auth Token from console.twilio.com.
  2. Enter your Twilio number. It's saved as +1…, and pasted spaces are removed.
  3. Click **Save** → **Check connection**. It confirms the login, that the number belongs to the account and can text, and warns if it's a trial account.
  4. Click **Connect replies for me**. It sets your number's *A message comes in* webhook, so customers' replies land in Conversations (or copy the URL shown into Twilio yourself).
  In the US your number must be **A2P 10DLC registered** (or a verified toll-free number), or carriers block texts.
- **GoHighLevel.** Texts go out through your GHL number using the token in Integrations → GoHighLevel (scopes: contacts.write, conversations/message.write, locations.readonly). For replies, create a GHL workflow: *Customer Replied* → *Webhook* (POST) to the URL shown.

When something fails, the reason is shown in plain words wherever you see the message: in the conversation, on the contract's activity, and in **Recent messages** at the bottom of the page. That includes Twilio carrier codes such as unregistered A2P (30034), trial-account limits (21608), landlines and STOP. Delivery reports from Twilio update each text to delivered or failed.

If a customer's reply is refused, usually because Twilio's webhook address and **Settings → Public URL** differ (Settings → Company → Public URL), a warning at the top of the page says so and how to fix it. Both your custom domain and the onrender.com address are accepted.

**Email.** Choose your provider: **Gmail/Google Workspace, Microsoft 365/Outlook, Yahoo, SendGrid, Mailgun, Amazon SES**, other SMTP, or **GoHighLevel**. The server settings are filled in for you, and the help text says exactly which password to use (for example a Google App Password; pasting it with spaces is fine). The **From** address defaults to *Company name <your login>*. Replies go to the rep who sent the email unless you set one Reply-to address. Optional: point Mailgun/SendGrid/Postmark inbound at the inbound URL to see email replies in Conversations.

**Alerts:** numbers and emails to notify when a contract is signed (optionally with the PDF), when one signer finishes, when a new 3D lead arrives, or when a customer replies. Each team member can also turn on their own alerts in **Account**. **Instant reply** sends an automatic text and/or email to new 3D leads. **Test mode** logs everything without sending, for training.

## GoHighLevel

Admin → **Integrations & API → GoHighLevel**. Use either option, or both.

### Option A — Native API (contact + opportunity + note)
1. In GHL (sub-account): **Settings → Private Integrations → Create new**. Give it the scopes **contacts.write** and **opportunities.write** (add *contacts.readonly* / *opportunities.readonly* if offered). Copy the token.
2. Copy your **Location ID** (Settings → Business Profile).
3. Optional: to create an opportunity, paste the **Pipeline ID** and **Stage ID** (visible in the pipeline settings URL / API).
4. Turn on *Send every new quote to GoHighLevel*, save, and click **Send latest quote to GHL now** to test.

Each new quote upserts the contact (name, email, phone, address, tags, source), creates an opportunity with the quote total, and adds a note with the full shed spec plus links to the 3D design and floor plan. **Custom fields** can be filled with a mapping like:

```json
{ "shed_style": "shed.style", "shed_size": "shed.size", "quote_total": "pricing.total", "shed_3d_link": "links.view_3d" }
```

(keys are your GHL custom field keys; values are paths in the Quote object below).

### Option B — Workflow “Inbound Webhook” trigger (no token)
1. GHL → **Automation → Workflows → Create** → trigger **Inbound Webhook** → copy its URL.
2. Paste it in *Inbound webhook URL* and save. Submit a test quote so GHL can see a sample payload, then map fields.
3. Add actions (Create/Update Contact, Create Opportunity, send SMS/email, assign user…).

The payload includes easy flat fields: `first_name, last_name, full_name, email, phone, address1, city, state, postal_code, quote_number, quote_total, shed_style, shed_size, shed_summary, options_list, shed_3d_link, floor_plan_link` — plus the full nested quote.

### Putting the builder on a GHL funnel/website
Admin → Integrations → **Embed / links** gives you an iframe snippet for a *Custom JS/HTML* element, direct links per style (`/?style=2`), and an optional `postMessage` listener. Set a **Thank-you page URL** in Settings to redirect after submission.

---

## Webhooks (any software)

Add webhooks in the admin or via the API. Every delivery is a `POST` with JSON:

```json
{ "event": "quote.created", "delivery_id": "uuid", "sent_at": "ISO date", "data": { …Quote… } }
```

Events: `quote.created`, `quote.updated`, `quote.status_changed`, `test` (or `*`). Failed deliveries retry after 1s, 5s and 25s. All attempts are visible in **Integrations → Delivery log**. You can add custom headers (e.g. an `Authorization` header your receiver expects).

**Verifying the signature** (when the webhook has a secret):

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-shedbuilder-signature']));
```

### The Quote object
```jsonc
{
  "id": 12, "number": "Q-10012", "status": "new", "created_at": "…",
  "customer": { "first_name", "last_name", "full_name", "email", "phone", "address", "city", "state", "zip", "notes", "sms_consent" },
  "shed": { "style": "Lofted Barn", "size": "12' x 16'", "width_ft": 12, "depth_ft": 16, "sq_ft": 192,
            "colors": { "siding": "Barn Red", "trim": "White", "roof": "Weathered Wood", "door": "Match Trim" } },
  "options": [ { "name": "4' Double Doors", "category": "doors", "wall": "front", "price": 0, "note": "Standard" } ],
  "pricing": { "subtotal", "delivery", "tax", "tax_rate", "total" },
  "summary": "Lofted Barn 12' x 16' | siding: Barn Red, … | Total: $9,450.00",
  "links": { "view_3d", "download_3d_model", "floor_plan_svg", "admin" },
  "config": { /* exact configuration — can be re-loaded into the 3D builder */ }
}
```

---

## REST API

Full interactive reference at **`/docs`**, machine-readable spec at **`/api/openapi.json`** (import into Postman, Make, n8n, etc.).

Create a key in **Admin → Integrations → API keys** and send it as `X-API-Key: sb_live_…` or `Authorization: Bearer sb_live_…`.

| Method & path | Auth | What it does |
|---|---|---|
| `GET /api/v1/catalog` | public | Styles (with sizes), colors, options, display settings |
| `POST /api/v1/price` | public | Price a configuration server-side |
| `POST /api/v1/quotes` | public | Submit a quote (fires webhooks + GHL) |
| `GET /api/v1/quotes?status=&since=&q=&limit=&offset=` | key | List quotes |
| `GET/PATCH/DELETE /api/v1/quotes/{id}` | key | Read, update status/notes, delete |
| `GET /api/v1/quotes/{id}/floorplan.svg` | key | To-scale floor plan |
| `POST /api/v1/quotes/{id}/resend` | key | Re-fire `quote.created` |
| `GET/POST/PATCH/DELETE /api/v1/webhooks[/{id}]` | key | Manage webhook subscriptions (REST hooks) |
| `POST /api/v1/webhooks/{id}/test` | key | Send a test delivery |
| `GET/POST/PATCH/DELETE /api/v1/{styles,sizes,colors,options}[/{id}]` | key | Manage the catalog |

Prices are always recalculated on the server, so a tampered browser can't submit a fake price.

---

## Downloads: 3D model & floor plan
- Customers: **3D model** button (top-right of the viewer, and on the success screen) downloads a `.glb` of their exact shed. **Floor plan** opens a to-scale plan (doors with swings, windows, shelves, loft, lights, outlets, ramp, dimensions, title block) that can be downloaded as SVG or printed / saved as PDF.
- Admin: each quote has *Open in 3D*, *Download 3D model (.glb)* and *Download floor plan*.
- Links in webhooks/GHL: `links.view_3d`, `links.download_3d_model`, `links.floor_plan_svg` (secret, unguessable per-quote token).

`.glb` files open in Windows 3D Viewer, macOS Preview/Reality Composer, Blender, SketchUp (via importer), and most online viewers.

---

## Try-it-now demo

`npm run build:demo` builds a static demo in `demo/dist/`: the 3D builder (`shed-builder-demo.html`) and the admin (`admin.html`). They share an in-browser stand-in for the server, so admin changes show up in the builder and submitted quotes appear in the admin. Data stays in that browser; webhooks and GoHighLevel only run on the real server. Serve both files from the same folder (with the builder as `index.html`). `node demo/build.mjs --seed http://localhost:3000` refreshes the sample catalog from a running server.

## Testing

```bash
npm test            # API + provider suites: CRM, contracts & signing, revisions, reports, roles, lots, concurrency, and real
                    # Twilio / GoHighLevel requests (stand-in API) and real email (local SMTP server), plus pricing
                    # (units, swaps, credits, tax, tiers by lot/ZIP, tampering), configurator settings, 3D model uploads,
                    # API keys + catalog CRUD, signed webhooks with retries, the GoHighLevel push, auto-replies and a full sale
npm run test:browser # 3D configurator in a real browser: uploaded .glb models render, price on screen = server price for
                    # every style, hidden prices / currency / required phone show on the page, settings pages don't clash
npm run test:e2e    # browser walkthrough: 4 roles at once, phone signing, revisions, dashboard (needs Playwright + Chromium)
npm run test:sweep  # bug sweep: every page x every role x desktop/phone, script-injection attempts, accented PDFs,
                    # double submits, expired links, oversized uploads, deleted users, restart
```
Both start their own server on a throw-away database in messaging test mode. The browser suite signs in as Admin, Sales, Production and Delivery **at the same time**, has a customer sign on an iPhone and a co-buyer on an Android phone, and walks a lead from the 3D builder through contract, signature, production and delivery. It prints where it saved screenshots and the signed PDF.

## Project layout

```
server.js                    Express app: API, admin, auth, uploads, static files
src/db.js                    SQLite schema + catalog loader
src/auth.js                  Admin sessions, password hashing, API keys
src/integrations.js          Webhooks (signed, retried) + GoHighLevel
src/crm.js                   CRM API: contacts, pipelines, messages, tasks, notifications, order board, inbound webhooks
src/contracts.js             Point of sale API: templates, contracts, sending, public signing API
src/contract-pdf.js          Contract PDFs (pdf-lib): fill, attach drawings, stamp signatures, certificate, sample templates
src/messaging.js             Twilio / SMTP / GoHighLevel texting & email
src/permissions.js           Role permissions + dealer-lot filtering
src/realtime.js              Live updates (Server-Sent Events)
public/sign.html, js/sign.js Customer signing page
public/admin/crm.js, pos.js  CRM, boards, messaging and point-of-sale screens
public/js/shared/contract.js Field types, merge tags, rent-to-own calculator
tests/                       API + browser end-to-end tests
src/openapi.js               OpenAPI 3.1 spec
src/seed.js                  First-run sample data
public/index.html            Customer configurator
public/js/configurator.js    Configurator UI logic
public/js/shed3d.js          Three.js engine: procedural shed, option models, picking, GLB export
public/js/shared/*.js        Pricing, geometry & floor plan — shared by browser and server
public/admin/                Admin dashboard
demo/                        Single-file demo build
render.yaml, Dockerfile      Deployment
```

## Notes
- E-signatures: each signer gets a unique link, agrees to an ESIGN/UETA consent, and every view/sign is logged with time, IP and device on the certificate. This is the standard approach for e-signing sales contracts, but it is not legal advice — have your attorney approve your templates and your rent-to-own disclosures for your state.
- The try-it-now demo (`npm run build:demo`) runs everything in the browser, CRM and point of sale included (`demo/dist/artifact/` is the claude.ai artifact bundle). Data stays in that browser; texts and emails are only logged.
- Prices shown are a quote, not a contract — tax and delivery are configurable in Settings; hide prices entirely with *Show prices to customers* off.
- The GoHighLevel native push uses the LeadConnector API v2 (`/contacts/upsert`, `/opportunities/`, `/contacts/{id}/notes`, header `Version: 2021-07-28`). If GHL changes scopes or endpoints, check **Integrations → Delivery log** for the exact response.
