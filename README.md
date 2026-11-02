# Crazyland daily donation bot

Checks only human members with the **Patient** role, ID `1532826238572298451`, for an image attachment in donation channel `1535655837828382740` each calendar day. The bot sends end-of-day reminders and missing-member pings in that same channel. Daily boundaries use **Europe/Paris** by default.

## What happens each day

- Every minute, the bot checks today's donation-channel history. Missing members get ` [No Donation Proof]` appended to their server nickname. This means the label appears from the beginning of each day until proof is posted.
- New members are not tagged immediately. Their first `[No Donation Proof]` tag can be applied only after the next 6:00 AM donation ping.
- An image upload triggers another check and receives the server's custom `check` emoji reaction. The label is removed after proof is found, while approved time off applies, or after the Patient role is removed.
- Shortly after 6:00 AM, the bot **pings yesterday's missing members in the donation channel**, explicitly naming the missed date. Approved days off for that date exclude members from the ping list. The new day's proof does not count for yesterday.
- Members on approved time off receive `[Vacation]` on their nickname and appear as **Excused** in reports. Pending requests do not excuse them. Their original nickname is restored—or changed to `[No Donation Proof]` if needed—when the vacation ends.

Daily proof tracking checks that an image was uploaded. AI donation totals use the separate leader-verification workflow below; pending or failed scans do not change daily proof reminders.

## AI donation totals and verification

For **Google AI Studio / Gemini**, set `AI_PROVIDER=gemini` and `GEMINI_API_KEY` in Railway Variables (or local `.env`). `GEMINI_VISION_MODEL` defaults to `gemini-3.5-flash-lite`; it can be changed to an image-capable model available to your Google project. Move a Google key mistakenly stored under `OPENAI_API_KEY` to `GEMINI_API_KEY`. Google free-tier usage is subject to project/model quotas; HTTP 429 means a quota or rate limit was reached. Blocked, unfinished or invalid AI responses never credit donations.

For **OpenAI**, set `AI_PROVIDER=openai` and `OPENAI_API_KEY`. `OPENAI_VISION_MODEL` defaults to `gpt-4o-mini` and may be set to another model supporting image input and structured outputs. When `AI_PROVIDER` is omitted, Gemini is selected if `GEMINI_API_KEY` is present, otherwise OpenAI. There is no automatic fallback between providers. Apply variable changes and restart/redeploy the bot. Without the selected provider's key, existing proof acknowledgements and daily tracking continue; automatic AI scanning is disabled. Never post keys in Discord or commit them. No extra npm dependency is needed.

New image submissions from tracked members and configured leaders in the donation proof channel are scanned automatically. The bot reads only green game system notices such as `08:09 /// Tomhawky donated 2 000 Gems to the Clan!`, ignoring chat and quest notices. It extracts all visible donation lines from up to five images (10 MB each), including cropped screenshots and different resolutions. Images are downloaded into memory and sent to the selected provider for scanning; OpenAI requests use `store: false`. Google's free-tier data-use terms apply when Gemini is selected. The bot saves extracted text, image hashes, links and approval history in the existing persistent state file, not image files.

Automatic scans and reaction approvals do not post public replies. Discord only supports ephemeral responses to interactions, so use `/donation action:Scan proof proof-id:MESSAGE_ID` to privately see extracted names, amounts or scan errors. The original custom check reaction means **received**, not credited. A member with a configured **Leader / approval role** must compare the extracted values with the screenshot, then click that custom reaction on the original screenshot or use Verify proof for a private success/error response. The bot credits the linked donors exactly once and keeps only the original custom check reaction; it adds no second verification reaction. Use Verify proof to see approval success or failure privately. A reaction count alone does not confirm credit. Existing bot-added green check reactions on saved approved/voided proofs are removed on startup when accessible. Other users' reactions do nothing; Administrator permission and Asylum Staff alone do not grant donation approval. Removing a reaction does not reverse credit. Approval applies to all donation lines in the message together and fails without partial credit if any name is unlinked or text is unclear. Saved public scan replies from older versions are removed on startup when accessible; previous unsaved error replies need manual removal.

Commands (all replies are private):

| Command | Who | Purpose |
| --- | --- | --- |
| `/donation action:Link member member:@Someone game-name:Tomhawky` | Leader / approval roles | Link or change the exact in-game name; a name cannot belong to two users |
| `/donation action:Donation total` | Members | View your verified Gems; optionally choose `member` to view another member |
| `/donation action:Scan proof proof-id:MESSAGE_ID` | Leader / approval roles | Scan an older/offline submission or retry a failed scan in the current proof channel |
| `/donation action:Verify proof proof-id:MESSAGE_ID` | Leader / approval roles | Approve a scanned proof, equivalent to the custom check reaction |
| `/donation action:Void donation proof proof-id:MESSAGE_ID` | Leader / approval roles | Remove all credit from a mistaken proof, preserving its audit record |

Enable Discord Developer Mode and use **Copy Message ID** on the original screenshot for `proof-id`. If a leader reacted before linking a name, link it and remove/re-add that leader's reaction, or use Verify proof. Old reactions are not replayed automatically after downtime. Older/offline submissions need Scan proof; history is not automatically sent to the AI. Proofs and totals persist across restarts. Relinking a name does not transfer previously credited donations to another Discord user. To correct an amount, void the mistaken proof and submit a clearer replacement, then scan and verify it.

Identical image files are rejected if already credited. Matching donor/amount/time lines also block approval to catch overlapping or recompressed screenshots. These images contain no reliable date or transaction ID, so matching lines may be legitimate repeats. After checking the originals, a leader can explicitly use `/donation action:Verify proof proof-id:MESSAGE_ID repeat-confirmed:true` to allow a separate donation with a matching line; this choice is recorded. Identical image files still cannot be overridden. Altered names, missing times and edited screenshots can evade duplicate detection, so leaders must check authenticity and repeats. Unreadable or partially cut-off donation text blocks the entire proof until a clearer replacement is provided. Deleting a credited screenshot does not erase its saved credit; use Void donation proof.

Implementation references: [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [Discord gateway intents](https://docs.discord.com/developers/events/gateway).

## Donation breaks

Use **/clan → action: Donation breaks** as a server administrator, then **Create break**. Enter a name (for example, Halloween break), inclusive start and end dates, and an optional announcement. Dates use the bot timezone; ISO dates such as `2026-10-30` or short dates such as `30 Oct` work. Breaks can last up to 365 days. Non-overlapping future breaks can be scheduled.

Creating a break posts one announcement in the configured donation proof channel. A future break is announced immediately and locks the channel when its start date arrives. The announcement updates when the break starts or finishes. Regular members can read but cannot post messages or create/post in threads during the break. Discord server owners and administrators bypass channel permission overwrites and can still post. No mass mention is sent.

Donation requirements, missing-proof labels and reminders pause during the break. Existing individual vacation labels still apply. Break dates stay excused in historical reports, so there are no catch-up reminders or missing-streak increments for them. Regular tracking resumes after the final date. Ending a break early unlocks the channel immediately but keeps the current date excused. Use **Cancel next break** to cancel a future break, or **End current break** to finish an active one.

The bot needs **Manage Permissions (Manage Roles)** in the donation channel, plus its normal read/send/embed/attachment permissions. Original posting overwrites are saved before locking and restored when the break ends, including after a restart. Unrelated permission changes are preserved. Failed channel updates are shown in the break panel and retried each minute. Keep the bot running and its data volume persistent; an expired break cannot unlock a channel while the bot is offline. Finish or cancel pending breaks before changing the donation proof channel in Setup.

## Server setup

Use **/clan → action: Setup** as a server administrator. Choose a setting, pick its channel or roles in the native Discord selector, then press **Save setup**. **Cancel** discards unsaved edits. The panel is private, expires after 30 minutes, and rejects stale saves if another admin has changed setup.

- **Vacation notice channel:** where the Vacation button message is posted or updated. Moving it replaces the old notice with a link to the new location when the bot can still edit it.
- **Donation proof channel:** where image submissions count as proof.
- **Donation reminder channel:** where missing-member reminders are sent; it can differ from the proof channel.
- **Time-off review channel:** where new requests and approval buttons are posted. Existing request messages remain reviewable in their original channel.
- **Tracked member role:** the one role whose human members must submit donation proof.
- **No longer a member role:** optional role that overrides the tracked member role. Members with it are excluded from donation checks and vacation requests. The bot removes its `[No Donation Proof]` and `[Vacation]` nickname markers, including orphan markers, while preserving other nickname text. Clear the selector to disable this exclusion. Role changes trigger a check immediately; the regular one-minute check also applies.
- **Leader / approval roles:** one or more roles allowed to approve time off. Server Administrator alone does not grant approval authority unless the admin also has a chosen leadership role.
- **Additional time-off roles:** optional extra roles that may request vacations. Tracked members and leaders can already request time off.

The tracked member role is automatically added to human users who lack it, including existing users on startup and new joins. Bots and anyone manually given the no-longer-a-member role are skipped. Configure the no-longer-a-member role as Patient No More and select Visitor in Setup. Assigning Patient, Patient No More or Visitor removes the other two membership roles. Removing a role does not advance a cycle. Setup includes a dedicated Set Visitor role button. Visitor also blocks automatic Patient assignment and donation tracking. The bot needs Manage Roles and a role above the tracked member role; assignment failures appear in the admin panel and retry on later checks. Automatic assignment rejects roles with Administrator or Manage Roles.

Saved choices take effect immediately and survive restarts in the persistent state file. They override the original channel and role defaults described below. Existing requests, grants and reminder progress are preserved. Channel permissions and selected roles are checked before saving. If a configured channel or role is deleted, Setup remains available to repair it.

## Commands and the Discord admin panel

On startup the bot posts the branded member vacations notice in channel `1549128315095355422`. Its red **Vacation** button opens a private form with the same values as `/clan action:Request time off`: start date, 1–365 days, and an optional reason (up to 500 characters). Submission uses the same role checks and admin approval process. This creates a time-off request, not a separate ticket channel. The notice is reused on restart, and its button keeps working. Give the bot View Channel, Read Message History, Send Messages, Embed Links and Attach Files in that channel.

| Command | Who can use it | Purpose |
| --- | --- | --- |
| `/clan action:Donation report` | Manage Server | Today's submitted, missing and excused members, with proof links |
| `/clan action:Donation report date:2026-09-14` | Manage Server | Report for a previous date |
| `/clan action:Request time off` | Members with an allowed time-off role | Open a private form for the start date, number of days and optional reason |
| `/clan action:My time off` | Members | View their own requests and approved dates |
| `/clan action:Admin panel` | Administrator | Open the private admin panel |
| `/clan action:Setup` | Administrator | Choose channels and member / leadership roles |
| `/clan action:Donation breaks` | Administrator | Schedule a break, announce it and temporarily lock donation posting |

The `/clan action:Admin panel` command opens a panel with buttons for **Requests & days off**, **Grant days off**, **Approve request**, **Reject request**, and **Revoke days off**. Requests, grants and automation issues appear directly in the embed, together with the pending-request count. The panel does not show tracked-member, timezone or last-check fields. Longer lists have **Previous** and **Next** buttons; no text-file cards are sent. Opening or refreshing the panel removes attachments left by an older version.

Members with role `1532826238572298451`, `1532826140086112256`, `1532826772624769316`, or `1532826889499185302` can submit `/clan action:Request time off`. The bot posts a styled request in admin channel `1537173435611090944` with **Approve** and **Reject** buttons. Only members with the Leader role (1532826140086112256) or Co-leader role (1532826772624769316) can approve requests, including approvals submitted through the admin panel. Administrator permission alone does not allow approval. Rejection and other admin-panel actions still require Administrator permission. After a decision, the request message shows who approved or rejected it and the buttons disappear. Manual decisions made through `/clan action:Admin panel` also update the matching request message when it is still available. Daily donation checks still track only the Patient role `1532826238572298451`.

To approve a request, open the list and copy its request ID into **Approve request**. The member's requested dates are approved as submitted. To assign different dates or grant time off without a request, choose **Grant days off** and enter the member's Discord ID, start date, and number of days. Reject an obsolete pending request separately.

Member start dates accept the day before or after an abbreviated or full English month, such as `10 Sep`, `Sep 10`, or `10 September`. Past start dates are rejected. Periods include both the start and end date, and can last 1–365 days. Overlapping grants are allowed; any applicable grant excuses the member. Revoking a grant voids that entire grant, including in later historical reports. It does not cancel other overlapping grants. Admins can grant retroactive days off, but this cannot retract reminders already sent. Members can request today or future dates and have up to five pending requests.

All command responses and the admin panel are private to the person using them. Members see approval or rejection through `/clan action:My time off`; the bot does not send DMs. Only the end-of-day reminder intentionally pings members.

## Setup

1. Install **Node.js 22.12 or newer**.
2. Create an application and bot at [Discord Developer Portal](https://discord.com/developers/applications). Enable **Server Members Intent** and **Message Content Intent** on the Bot page.
3. Invite it to your server with the `bot` and `applications.commands` scopes. Give the bot **View Channels**, **Read Message History**, **Add Reactions**, **Send Messages**, **Attach Files**, **Embed Links**, and **Manage Nicknames**. Check channel overrides in donation channel `1535655837828382740`, admin channel `1537173435611090944`, and channels where commands are used.
4. Move the bot's highest role **above the highest role of every Patient member whose nickname it must edit**. Discord does not allow the bot to rename the server owner or members above/equal to its role. The admin panel reports these failures; eligible members still appear in reminder lists.
5. Enable Discord Developer Mode, then copy your server ID and donation text-channel ID. Patient role ID `1532826238572298451` is already set in `state.js`; any old `CLAN_ROLE_ID` setting is ignored.
6. Copy `.env.example` to `.env`, then set `DISCORD_TOKEN`, `GUILD_ID`, and `DONATION_CHANNEL_ID`. Keep the token private. Set `TIMEZONE` before first launch if the clan uses a timezone other than Europe/Paris.
7. From the project directory run:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

Keep the process running for automatic checks. Run **only one instance** for this server. Stop it with Ctrl+C. Slash commands are registered for the configured server on startup. No separate web dashboard is needed.

## Railway

Deploy this repository as a Railway service and use `npm start`. The local `.env` file is optional; on Railway, set `DISCORD_TOKEN`, `GUILD_ID`, `DONATION_CHANNEL_ID=1535655837828382740`, and `TIMEZONE=Europe/Paris` in the service's Variables tab. Do not upload `.env` to GitHub.

Attach a persistent volume at `/app/data` before starting the bot, keep one replica, and leave the HTTP healthcheck path empty. The bot has no web server and needs no public domain. After deployment, check logs for `Ready: Patient daily checks in Europe/Paris.`

## Message appearance

All bot replies use colour `#f45f77`, the message heading in the author row beside the pointing-hand icon, and a footer reading **Crazyland Asylum** beside the small Crazyland logo. Larger embeds also show the Crazyland logo in the top-right corner. There is no separate embed title. Compact reminders omit the top-right logo and match the supplied example: **Crazyland clan donation reminder.** in the author row and **Don't forget to donate your daily!** in the body, without statistic fields. The missed date and actual member pings appear above the embed. Reports, personal time-off lists and admin issues are shown in the embeds with page buttons when needed. Reports include clickable screenshot links; there are no text report attachments.

The supplied pointing-hand image is bundled as `assets/author-icon.png`, the small Crazyland logo as `assets/footer-icon.png`, and the wider Crazyland logo as `assets/thumbnail-icon.png` for the top-right of larger embeds. They are attached directly to each message. No image URL variables are needed in Railway. Bundled assets take priority over the corresponding image URL settings. The bot needs **Embed Links** and **Attach Files** permissions in the donation and admin channels.

## Storage, recovery and limits

- `data/state.json` stores requests, grants, original nicknames and reminder progress. It is created on first startup and excluded from Git. **Keep this folder on persistent storage and back it up**. Writes replace the file atomically. Corrupt state causes startup to fail rather than silently forgetting exemptions or nickname originals.
- Nicknames are limited to 32 characters by Discord, so a long name is shortened while tagged. Its full original nickname is restored when the tag clears. Members who had no server nickname are restored to no nickname. Later manual nickname edits are preserved when possible. This changes the server nickname, never the account username.
- On first installation, tracking starts with the current day, with no reminders for earlier days. After a restart, saved progress allows missed days to be processed, up to seven per check. A interrupted reminder is checked against bot message history before resending. Failed scans do not produce a partial missing list.
- Current Patient membership is used even for historical dates and downtime catch-up; membership history is not recorded. Someone newly assigned Patient before catch-up may appear as missing on an earlier date. Today's report remains provisional until the day ends.
- Direct PNG, JPEG, WebP and GIF attachments with image metadata count. Image links, embeds, videos, thread posts, bot posts and webhook posts do not count. Multiple images by one member still count as one submitted member.
- Reports re-read Discord history. Images posted while the bot was offline still count. Deleting an image removes its proof from future checks; editing an image attachment is reflected on the next check. Deleting channel history also deletes evidence. Submitted screenshots are not downloaded to disk.
- Scans have a 10,000-message safety limit. Use a dedicated donation channel. Deleted reminder history can prevent duplicate-send recovery after a crash.
- State is bound to the server and timezone; changing either requires a deliberate state migration. Do not delete the state file while labels are applied, as that loses the full original nicknames.

## Verification

Run `npm.cmd test` for local tests of date boundaries, Patient-only filtering, inclusive exemptions, expiry, access checks, nickname restoration, persistence, reminder batching, midnight processing and interrupted-send recovery. Tests use fake Discord members/channels and never connect to Discord.

For a live check in a test server with the configured role: start the bot, confirm a missing Patient gets the label, upload an image, and confirm the label clears. Request time off, approve it in `/clan action:Admin panel`, and check that `/clan action:Donation report` lists the member as Excused. Confirm a non-admin cannot open the admin panel. At the next local midnight, check that only missing, non-excused Patients are pinged for the day that just ended.

References: [discord.js API](https://discord.js.org/docs/packages/discord.js/stable) and [Discord gateway intents](https://docs.discord.com/developers/events/gateway).
