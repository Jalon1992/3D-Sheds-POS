# Test drive: version 2 (CRM + point of sale)

This puts the `v2-pos-crm` branch online at its own address so you can try everything (including uploading your real Cash and Rent-to-Own contracts) without touching anything else.

## 1. Put it online (Render, about 10 minutes)

1. Go to **render.com** and sign in (or sign up) with GitHub. When asked, give Render access to **Jalon1992/3D-Sheds-Trimline-Barns**.
2. **New → Blueprint** → pick **3D-Sheds-Trimline-Barns** → set **Branch** to **`v2-pos-crm`**.
3. Enter the login you want under `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then **Apply**. Render builds it on the Starter plan with a 1 GB disk (about $7/month; delete the service when you're done testing to stop billing).
4. When it says **Live**, open `https://<your-service>.onrender.com/admin/` and log in.
5. **Settings → Public URL**: paste that same `https://….onrender.com` address and save. Signing links use it.

## 2. Upload your two contracts

1. Save each contract as a **PDF** (Word or Google Docs: File → Save as / Download → PDF). Locked or password-protected PDFs are fine; the upload makes an unlocked copy.
2. **Point of sale → Templates → + Upload template**: upload the cash contract with **Used for: Cash sales**, then the RTO contract with **Rent-to-own sales**.
3. In the designer, click a field type, then click where it goes on the page:
   - **Signature**, **Initials** and **Date signed** for the Customer (and Co-buyer / Company if your contract has those lines). You need at least one Customer signature.
   - **Auto-filled info** for the buyer name, address, phone, building, price lines, deposit, and the RTO monthly payment / term / due at signing / total of payments.
   - Optional: the **3D rendering** and **floor plan** images, and custom values (e.g. anchor type) the rep types in.
4. Leave **Attach drawings** and **Customer initials each drawing sheet** ticked, then **Save**.
5. **Point of sale → Rent-to-own & contract settings**: enter your RTO company's term factors (the defaults are placeholders) and your cash deposit %.

## 3. Sell a shed, start to finish

1. Open the builder (`/`), design a shed and submit a quote with **your own** email and mobile. It appears in **Contacts** right away.
2. Open the contact → **New contract** → Cash or Rent to own → **Prepare contract**. Check the PDF preview.
3. Get it signed:
   - **Email the link**: works once email is connected (step 4).
   - **Copy link** and text it to yourself from your phone, or
   - **Sign now (in person)** to sign on the same screen, as on a lot tablet.
4. Sign on your phone, then tap **Sign as company** on the contract page. Download the signed PDF: contract, signatures, 3D rendering, floor plan, elevations and the certificate, all in one file.
5. Open **Production & delivery** to see the order. Add yourself a Production and a Delivery login (Account & users) in another browser to see how each role works.

## 4. Optional: real texts and emails

**Messaging & alerts**:
- **Email:** the fastest option is Gmail or Google Workspace. Choose SMTP with host `smtp.gmail.com`, port `587`, your address, and a Google **App Password** (Google Account → Security → App passwords). Click **Send test email**.
- **Texts:** if your GoHighLevel number already sends texts, choose **GoHighLevel** (it uses the token in Integrations → GoHighLevel). Otherwise choose Twilio. A new Twilio number needs A2P 10DLC registration before carriers deliver texts, which can take days.
- **Text/email alerts to:** add your number and email to get the "contract signed" alert.
- **Test mode:** logs messages in the CRM without sending, for training staff.

Something not right? Note the page, what you clicked, and what you expected, and send it over.
