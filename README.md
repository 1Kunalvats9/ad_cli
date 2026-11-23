# webclone

A command-line tool that clones a web page into a local **HTML + CSS + JavaScript**
code base.

It opens the page in a real (headless) Chrome browser and saves every file the
browser actually loads: stylesheets, scripts, lazy-loaded chunks, fonts, images and
CSS-in-JS styles. Sites built with React, Next.js, Framer, Webflow and similar come
out looking right, not just plain static HTML.

```
$ node bin/webclone.js https://getbootstrap.com --serve

Opening https://getbootstrap.com/ in headless Chrome
  Scrolling through the page to load lazy content...
  ✓ Captured 30 files loaded by the browser
Downloading 4 more files referenced by the HTML/CSS
Writing files

Done! Cloned in 8.4s
  Folder  : /…/cloned_sites/getbootstrap.com
  Files   : index.html + 3 CSS · 10 JS · 9 images · 11 fonts  (1.1 MB)

Preview running at http://localhost:8000/
```

## Quick start (make commands)

```bash
cd ad_cli
make preview URL=devark.studio     # clone the page and open a preview
```

| Command | What it does |
| --- | --- |
| `make` | Show all commands |
| `make clone URL=example.com` | Clone a page (HTML + CSS + JS) |
| `make static URL=example.com` | Clone a static snapshot (no JavaScript, opens by double-click) |
| `make preview URL=example.com` | Clone, then start the preview server |
| `make serve` | Preview the most recent clone (or `make serve DIR=cloned_sites/x`) |
| `make list` | List your cloned sites, newest first |
| `make clean` | Delete all cloned sites (asks first) |
| `make link` | Install `webclone` as a command you can run from anywhere |

Extra options: `OUT=<folder>` to choose the output folder and `PORT=<port>` for the
preview port, e.g. `make clone URL=example.com OUT=cloned_sites/mine`.
Dependencies are installed automatically the first time.

## Setup

You need Node.js 20.18 or newer. (`make` does this step for you.)

```bash
cd ad_cli
npm install          # also downloads a private copy of Chrome for Puppeteer
```

Optional: make `webclone` available as a command everywhere:

```bash
npm link
```

## Usage

```bash
node bin/webclone.js <url> [options]       # clone a page
node bin/webclone.js serve [folder]        # preview a clone in your browser
```

(After `npm link`, use `webclone ...` instead of `node bin/webclone.js ...`.)

| Option | What it does |
| --- | --- |
| `-o, --output <dir>` | Output folder (default: `./cloned_sites/<domain>`) |
| `--static` | Save the page exactly as rendered, without JavaScript (see below) |
| `--serve` | Start the preview server right after cloning |
| `--port <n>` | Preview port (default: 8000) |
| `--width <px>` | Browser window width (default: 1440) |
| `--timeout <sec>` | How long to wait for the page to load (default: 45) |
| `--no-scroll` | Don't scroll the page to trigger lazy-loaded content |
| `--insecure` | Ignore invalid HTTPS certificates |
| `-q, --quiet` | Only show errors and the summary |

Examples:

```bash
node bin/webclone.js example.com
node bin/webclone.js https://getbootstrap.com -o bootstrap --serve
node bin/webclone.js https://vercel.com --static
```

## Two modes

**Default: working copy (HTML + CSS + JS).** Saves the page's original HTML and
every file it loads, keeping the site's own folder structure. The page's JavaScript
runs as on the real site (animations, menus, sliders). View it with
`webclone serve`, because the HTML uses root-relative paths (`/assets/app.js`)
just like the real site.

**`--static`: exact snapshot.** Saves the page as it looks after JavaScript has run,
with all styles frozen in, and removes the scripts. You get the closest visual match
and it opens by double-clicking `index.html`, but nothing is interactive. Use it for
single-page apps, or for sites that block copies of themselves. Vercel, for example,
sends any copy of its site back to vercel.com.

## What you get

```
cloned_sites/example.com/
├── index.html          the page, with links pointing at the local files
├── webclone.json       where each file came from (used by `serve`)
├── assets/ , _next/ …  the site's own files, in the same folders as on the server
└── _external/          files from other domains (CDNs, Google Fonts, …)
    └── fonts.gstatic.com/…
```

How it works:

1. Opens the page in headless Chrome, scrolls through it to trigger lazy loading,
   and records every CSS, JS, image, font and media file the browser downloads.
2. Downloads files that the HTML/CSS reference but the browser didn't load yet,
   such as hover images or `@import`ed stylesheets.
3. Rewrites the URLs in the HTML and CSS to point at the local copies. Links to
   other pages still go to the live site.
4. `webclone serve` previews the clone. If the page later asks for a file that
   wasn't cloned, the server fetches it from the live site, so nothing breaks.

## Limitations

- **One page at a time.** It clones the URL you give it, not the whole website.
- Files that only load after you click something (menus that fetch data, other
  pages) aren't cloned up front. In the preview they're fetched from the live site.
- Some sites block headless browsers (HTTP 403/429, Cloudflare checks), or redirect
  copies of themselves back to the real domain. Try `--static` for those.
- Code is saved exactly as the server sent it, so minified CSS/JS stays minified.

Only clone sites you have permission to copy, and respect their terms of use and copyright.
