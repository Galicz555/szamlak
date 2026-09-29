export const STYLE = `
:root { color-scheme: light dark; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --muted: #6e7781; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 64rem; padding: 0 1rem 3rem; }
header nav { display: flex; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--muted); }
.status { display: flex; justify-content: space-between; align-items: start; gap: 1rem; font-size: .875rem; padding: .5rem 0; }
.status ul { margin: 0; padding-left: 1rem; }
.bad { color: var(--bad); }
.muted { color: var(--muted); font-size: .875rem; }
.filters { display: flex; gap: 1rem; margin-bottom: 1rem; }
.filters [aria-current] { font-weight: bold; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { padding: .1rem .5rem; border-radius: 1rem; font-size: .8rem; border: 1px solid currentColor; white-space: nowrap; }
.badge.paid { color: var(--ok); } .badge.awaiting { color: var(--warn); } .badge.overdue { color: var(--bad); font-weight: bold; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
dt { font-weight: 600; } dd { margin: 0; }
.candidates { list-style: none; padding: 0; } .candidates li { border: 1px solid var(--muted); border-radius: .5rem; padding: .5rem 1rem; margin-bottom: .5rem; }
label { display: block; font-weight: 600; margin: .5rem 0 .25rem; }
input[type=url], select { width: 100%; max-width: 40rem; padding: .3rem; }
button { margin-top: .5rem; padding: .35rem .9rem; cursor: pointer; }
:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
