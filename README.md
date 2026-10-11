# webApps
A collection of web apps to be run on GitHub pages by choosing a specific branch

## This branch: Cut List Calculator & Deck Planner

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

## Deck planner

A second tab for working out how many deck boards a deck resurface needs, how
to cut them, and where each piece goes. It's a materials estimate, not a
structural design — it doesn't check joist spans or spacing.

**Draw the deck.** Add a rectangle by size, or use *Draw area* to tap out any
straight-edged outline (L-shapes, bump-outs, notches). Corners snap to a grid and
to other areas' corners. Drag corners to reshape, drag an area to move it (it
glues to a neighbour's corner), and use *Add corner* to split an edge. Edge
lengths can be typed exactly in the area's settings.

**Several areas.** Draw as many areas as you like — e.g. an upper and a lower
deck. Each has its own board direction, joists and edge boards, but all pieces
are packed together, so an offcut from one area can be used in another.

**Edge boards.** Each area gets a border of edge boards with mitred corners.
Set their width per area and switch any edge off where it meets the house or
another area.

**Joists.** Draw joists as lines with their own width, or generate them at an
even spacing perpendicular to the boards. Board ends are cut so every joint
lands on a joist centreline, and joints in neighbouring rows are staggered.
Without joists the planner still works, but warns that joints are unsupported.

**Boards.** Set the board width, the gap between boards (also used between ends
and against edge boards), saw kerf, and the lengths you can buy — a list by
default, or a single length. Prices are optional; if every length has one, the
cheapest mix is chosen. An "extra to buy" percentage covers mistakes and culls.

**Direction.** Boards run at an angle measured from any edge of the area —
parallel, perpendicular, 45° diagonal, or any value — and rows can start from
either side.

**Results.** A shopping list, one cut bar per purchased board, and a table of
every piece. The layout is drawn on the footprints: boards are labelled and
coloured by the stock board they come from, so you can see how offcuts are
reused. Tap a board to see everything cut from the same stock board. Angled
and notched ends are counted at full length, so diagonal layouts are a
slightly conservative estimate.

The layout maths lives in `deck-engine.js` (no DOM, usable from Node) and the
drawing UI in `deck.js`.
