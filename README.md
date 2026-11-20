# Alber Opbr — Client-Side Roblox Account Data & Support Helper

**Live Portal:** [https://goky40.github.io/alberopbr/](https://goky40.github.io/alberopbr/)

Alber Opbr is a privacy-first, 100% client-side web portal designed to help users inspect Roblox account export archives (`access-results.zip`) locally inside their browser and organize structured, sanitized summaries for Roblox Support inquiries.

---

## Key Features

- **100% Local Browser Processing:** All ZIP decompression and CSV parsing happen locally on the user's device. Your raw `access-results.zip` archive is never uploaded to any external server.
- **Privacy & PII Protection:** Automatically strips sensitive internal numeric identifiers (`id`, `user_id`) and prevents exposure of passwords, session cookies, 2-Step Verification secrets, backup codes, or full payment-card numbers.
- **Chronological Account & Email Audit:**
  - Lists active and verified email records cleanly.
  - Compares the earliest recorded email timestamp against the account's creation date (`UTC`).
  - Reconstructs a chronological timeline of email updates and recovery transitions.
- **Billing & Receipt Organization:** Formats official transaction references (`GPA.`, Apple App Store, Stripe) and highlights earliest and recent purchase records to help users prepare clear, accurate support documentation.
- **One-Click Clipboard Summary:** Packages the sanitized diagnostic summary directly to your clipboard so you can paste it into your support workflow without manual extraction on mobile or desktop.

---

## How to Use

1. Open the hosted portal: **[https://goky40.github.io/alberopbr/](https://goky40.github.io/alberopbr/)**
2. Click the file selector button and choose your `access-results.zip` file as-is (no manual unzipping required).
3. Wait a moment for local browser parsing to complete; the sanitized summary is automatically copied to your clipboard.
4. Paste the generated summary into your support review session to generate a structured timeline and support message draft.

---

## Security & Privacy Notice

- **Never share credentials:** Do not share passwords, `.ROBLOSECURITY` cookies, one-time verification codes, backup codes, or full payment-card details with anyone.
- **Unofficial Community Tool:** Alber Opbr is an independent utility tool and is not affiliated with, endorsed by, or operated by Roblox Corporation.
