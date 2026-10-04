# dsa.step()

Data structures and algorithms, animated one step at a time next to the C++ that runs them.

Plain static HTML. No framework, no build step.

```
index.html          landing page with a card per topic
trees/index.html    tree algorithms (37 patterns)
graphs/index.html   graph algorithms (20 patterns)
shared/theme.css    colors, fonts, light/dark tokens
shared/theme.js     saved theme + [data-theme-toggle] buttons
```

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

## Add a topic

1. Create `<topic>/index.html`. Load `../shared/theme.js` in `<head>` and add an `← All topics` link to `../index.html`.
2. Turn its card on the homepage into a link and swap the "Coming soon" pill for a live one.

Now that `trees/` and `graphs/` both exist, move what they share (player controls, code panel, tracer) into `shared/`.

## Deploy

Any static host. Point Vercel, Netlify or Cloudflare Pages at the repo root with no build command.
