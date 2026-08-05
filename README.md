# webApps
A collection of web apps to be run on GitHub pages by choosing a specific branch

## This branch: Cut List Calculator

A mobile-friendly wood cut list calculator. Enter the stock boards your store
sells (length required; width, thickness, and price optional) and the cuts you
need (length and quantity required), and it computes the cheapest set of boards
to buy plus a per-board cut plan, accounting for saw kerf. Static HTML/CSS/JS —
no build step; point GitHub Pages at this branch to publish.

### Matching stock to cuts

Thickness always has to match exactly — a 3/4″ piece only ever comes from 3/4″
stock, since you buy the thickness you need rather than planing a board down.
"Allow cuts from wider stock" applies to width alone: with it on, a piece can be
ripped out of a wider board or sheet. A blank width or thickness is a wildcard.

### Reading the cut plan

Each board is drawn to its real length × width proportions, so a 4′×2′ sheet
looks like a sheet and a 1×6 looks like a board. Pieces are laid out along the
board's length only; where a piece is narrower than the stock, the hatched strip
above it is width you rip off and discard — not room for another cut. When every
board and piece has a width, the utilization stat is measured by area so that
rip waste counts against it.

### CSV import / export

**Export CSV** writes the current settings, stock boards and cuts to a
`cut-list-YYYY-MM-DD.csv` that imports back unchanged. The format is one row per
entry, tagged by section:

```csv
section,length,width,thickness,price,qty
stock,96,5.5,0.75,11.00,
cut,"2' 3 1/2""",3,0.75,,2
setting,kerf,1/8,,,
setting,allowLarger,yes,,,
```

**Import CSV** also accepts a plain spreadsheet export with just a header row —
column names like `length`/`len`, `width`, `thickness`, `price`, `qty`/`quantity`
are recognized in any order. Without a `section` column, rows are read as cuts,
or as stock boards if the sheet has a `price` column and no `qty`.
