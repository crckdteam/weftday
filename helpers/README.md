# Teams calendar in Weftday (view-only)

`teams-to-google.gs` copies the meetings from a company Teams / Outlook calendar into a Google calendar
called "Teams" in your own Google account. Weftday then shows it like any other calendar.

- It checks every 15 minutes and copies new, changed and cancelled meetings.
- It is one way only. Nothing is ever changed in Teams or Outlook.
- It runs inside your own Google account (Google Apps Script). No other server is involved.
- You do not need your company's IT to approve anything, as long as your company lets you publish your calendar.

## Set it up (about 5 minutes)

1. **Get the calendar link from Outlook.** Open [outlook.office.com/calendar](https://outlook.office.com/calendar) with your
   company account (the same login as Teams). Press the gear → **Calendar** → **Shared calendars**. Under
   **Publish a calendar** pick **Calendar** and **Can view all details**, press **Publish**, and copy the link that ends in `.ics`.
2. **Create the helper.** Open [script.google.com](https://script.google.com) with the Google account you use in Weftday and
   press **New project**. Delete what is there and paste in everything from `teams-to-google.gs`.
3. **Paste your link** between the quotes on the `ICS_URL` line near the top.
4. **Switch on Calendar access.** On the left, press **+** next to **Services**, choose **Google Calendar API**, press **Add**.
5. **Start it.** At the top, choose the function **install**, press **Run**, and allow access when Google asks.
6. **Open Weftday** and tick the new **Teams** calendar.

## Good to know

- The Outlook link lets anyone who has it see your meetings. Keep it private, and check that publishing is fine with your company.
- To stop: run the function **uninstall**. To remove the copies, delete the "Teams" calendar in Google Calendar.
- To stop sharing from Outlook's side: go back to **Shared calendars** and press **Unpublish**.
- Past one-off meetings stay in the Google calendar even after Outlook stops listing them.

## Checking the helper

```bash
node test/teams-helper.test.mjs
```
