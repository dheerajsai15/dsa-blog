# dsa.step()

Data structures and algorithms, animated one step at a time next to the C++ that runs them.

Plain static HTML. No framework, no build step.

```
index.html          landing page with a card per topic
trees/index.html    tree algorithms (37 patterns)
graphs/index.html   graph algorithms (20 patterns)
lists/index.html    linked lists (18 patterns)
dp/index.html       dynamic programming (17 problems, recursion → memo → table)
hashing/index.html  arrays & hashing (11 problems)
twopointers/index.html  two pointers (10 problems)
window/index.html   sliding window (10 problems)
stack/index.html    stack (9 problems)
binarysearch/index.html  binary search (9 problems)
shared/theme.css    colors, fonts, light/dark tokens
shared/theme.js     saved theme + [data-theme-toggle] buttons
shared/stepper.js   engine for the array-style pages: player, code panel, blocks, custom input
shared/stepper.css  layout and block styles for those pages
```

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

## Add a topic

Newer pages are built on `shared/stepper.js`. A page loads `../shared/stepper.css` and `../shared/stepper.js`, registers problems with `Stepper.add({ id, cat, title, code, params, run(T, p) { ... } })` and ends with `Stepper.start('firstId')`. Inside `run`, each `T.step(mark, message, blocks)` records one frame: `mark` names a `//@mark` comment in the C++ and `blocks` (from `Stepper.B`: `arr`, `map`, `chips`, `vars`, `grid`, `bars`, `ivl`, `tree`, `text`) describe the stage.

Then turn the topic's card on the homepage into a link and swap the "Coming soon" pill for a live one.

`trees/`, `graphs/`, `lists/` and `dp/` predate the shared engine and still carry their own copies of the player.

## Deploy

Any static host. Point Vercel, Netlify or Cloudflare Pages at the repo root with no build command.
