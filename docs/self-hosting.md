# Host your own copy

Weftday is a folder of static files. Hosting it means putting that folder somewhere a browser can
reach it. There is nothing to build and no server to run.

## 1. Put the files somewhere

### On your own computer

```bash
git clone https://github.com/crckdteam/weftday.git
cd weftday
node serve.mjs
```

Open http://localhost:4321. To use another port: `PORT=5000 node serve.mjs`. The server only
answers on your own computer.

### On a static host

Copy the `public/` folder, as it is, to any static host: GitHub Pages, Netlify, Cloudflare Pages,
an S3 bucket, or a folder on your own web server.

Things to know:

- **Use HTTPS.** Browsers allow recording, offline use and sign-in only on a secure address.
  `http://localhost` counts as secure, which is why the local server works.
- **A subfolder is fine.** The app uses relative addresses, so `https://example.com/weftday/`
  works as well as the top of a domain.
- **Set your address.** Edit `public/config.js` and change `PUBLIC_URL` to the address of your
  copy. It is used to make the "use it on your phone" link when the app runs on a computer's own
  address. Leave `MOVED_FROM` in that file as it is: it only matters to the published app, which
  changed address once.
- **You need only `public/`.** The `site/` folder is Weftday's own website and the `legacy/` folder
  is the page left at the published app's old address. Neither is part of the app.
- **No server settings are needed.** The Content Security Policy is inside `public/index.html`.
- **When you update your copy,** raise the version name in `public/sw.js` (`planner-shell-vN`)
  so every device drops its old kept copy.

Try it first with sample data: add `?demo` to the address. That needs no Google account.

## 2. Create a Google Cloud client

To connect a Google account, Weftday needs a Google Cloud "OAuth client": a Client ID and a
Client secret. You create it once, and it takes about ten minutes. The same steps are in the app
under **Settings → Advanced → How to get these**, where the two addresses for step 5 are filled
in for you.

1. Open [console.cloud.google.com](https://console.cloud.google.com/projectcreate) and create a
   project called "Weftday".
2. Go to **APIs & Services → Library**, find **Google Calendar API** and press **Enable**.
3. Go to **Google Auth Platform** (the OAuth consent screen). Choose **External**, and give it a
   name and your email.
4. Under **Audience**, press **Publish app**. This stops Google signing you out every 7 days.
5. Under **Clients**, create a client of type **Web application**.
   - Under "Authorised JavaScript origins" add the origin of your copy, for example
     `https://example.com` or `http://localhost:4321`.
   - Under "Authorised redirect URIs" add the folder your copy is served from, ending in a slash,
     for example `https://example.com/weftday/` or `http://localhost:4321/`.
6. In Weftday, open **Settings → Advanced**, paste the Client ID and Client secret into the boxes,
   and press **Save**.
7. Press **Connect Google account**. Google shows a "not verified" warning. Choose
   **Advanced → Go to Weftday**. That is expected for a private app.

The Client ID and Client secret are kept in your browser. They are never written to the
repository, and you should not commit them.

One shared, Google-approved app is planned, so that these steps will no longer be needed.

### For share links

Share links copy a recording to your own Google Drive. For that, also enable the
**Google Drive API** in the same project (**APIs & Services → Library**). The first time you make
a share link, Google asks you to let Weftday add files to your Drive. Weftday can see only the
files it put there itself.

### Other devices

Once one device is set up, you do not repeat these steps. Open **Settings → Accounts → Set up a
device** on the device that works, and scan the square with the new one or copy the link.

## 3. Add the AI key

AI notes, "Ask your meetings" and "Get facts" use a key that belongs to you. Google's is free.

1. Open [Google AI Studio](https://aistudio.google.com/apikey) and press **Create API key**.
2. Copy the key and paste it into **Settings → AI** in Weftday.

The key is kept in your browser and is sent only to Google's AI. Google's terms for that key
apply to what is sent with it.

Settings → AI also lists other AI services and web-search services you can use with a key of your
own, each marked free or paid. All of them are optional. Ollama runs on your own computer, so
with it nothing leaves the device.

To allow a service that is not in the list, it has to be added to `public/services.js` and to the
`connect-src` list of the Content Security Policy in `public/index.html`.

## 4. A Teams or Outlook calendar (optional)

A small helper copies a company Teams or Outlook calendar into your Google account, to look at
only. It runs inside your own Google account. Press **+ Add Teams calendar** in the app, or read
[../public/helpers/README.md](../public/helpers/README.md).

## Your duties under the licence

Weftday is under the GNU AGPL-3.0. If you change the code and let other people use your copy over
a network, you must offer them the source code of your version. Hosting an unchanged copy only
needs the licence and copyright notices kept in place. See [../LICENSE](../LICENSE).
