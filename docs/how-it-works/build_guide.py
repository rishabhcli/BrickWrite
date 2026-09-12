#!/usr/bin/env python3
"""Build the Brickwright visual guide as fixed A4 pages, then print to PDF."""

from __future__ import annotations

import html
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT_HTML = HERE / "guide.html"
OUT_PDF = ROOT / "docs" / "how-brickwright-works.pdf"

INTER_R = "/usr/share/fonts/truetype/macos/Inter-Regular.ttf"
INTER_M = "/usr/share/fonts/truetype/macos/Inter-Medium.ttf"
INTER_S = "/usr/share/fonts/truetype/macos/Inter-SemiBold.ttf"
INTER_B = "/usr/share/fonts/truetype/macos/Inter-Bold.ttf"
NOTO_R = "/usr/share/fonts/truetype/noto/NotoSansDisplay-Regular.ttf"
NOTO_B = "/usr/share/fonts/truetype/noto/NotoSansDisplay-Bold.ttf"
MONO_R = "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf"
MONO_M = "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Medium.ttf"


def e(text: str) -> str:
    return html.escape(text, quote=True)


def node(title: str, body: str = "", kind: str = "navy") -> str:
    extra = f"<span>{e(body)}</span>" if body else ""
    return f'<article class="node {kind}"><strong>{e(title)}</strong>{extra}</article>'


def arrow_d() -> str:
    return '<div class="arrow-d" aria-hidden="true"><i></i></div>'


def arrow_r() -> str:
    return '<div class="arrow-r" aria-hidden="true"><i></i></div>'


def cap(text: str) -> str:
    return f'<p class="cap">{e(text)}</p>'


def callout(text: str, kind: str = "") -> str:
    cls = f"callout {kind}".strip()
    return f'<div class="{cls}">{text}</div>'


def kbd(keys: str) -> str:
    return " ".join(f"<kbd>{e(k)}</kbd>" for k in keys.split(" · "))


CSS = f"""
@font-face {{ font-family: Inter; src: url('file://{INTER_R}') format('truetype'); font-weight: 400; }}
@font-face {{ font-family: Inter; src: url('file://{INTER_M}') format('truetype'); font-weight: 500; }}
@font-face {{ font-family: Inter; src: url('file://{INTER_S}') format('truetype'); font-weight: 600; }}
@font-face {{ font-family: Inter; src: url('file://{INTER_B}') format('truetype'); font-weight: 700; }}
@font-face {{ font-family: NotoDisp; src: url('file://{NOTO_R}') format('truetype'); font-weight: 400; }}
@font-face {{ font-family: NotoDisp; src: url('file://{NOTO_B}') format('truetype'); font-weight: 700; }}
@font-face {{ font-family: Jet; src: url('file://{MONO_R}') format('truetype'); font-weight: 400; }}
@font-face {{ font-family: Jet; src: url('file://{MONO_M}') format('truetype'); font-weight: 500; }}

:root {{
  --navy: #102226;
  --ink: #1A2224;
  --muted: #5A686C;
  --paper: #F3EFE6;
  --white: #FFFdf8;
  --line: #D5D8D0;
  --teal: #0E7A82;
  --amber: #B86A12;
  --sage: #3D7A3A;
  --coral: #C24538;
  --soft: #E7EBE4;
}}

* {{ box-sizing: border-box; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
html, body {{
  margin: 0;
  padding: 0;
  background: #fff;
  color: var(--ink);
  font-family: Inter, sans-serif;
  font-size: 9.6pt;
  line-height: 1.42;
}}

@page {{ size: A4; margin: 0; }}

.page {{
  width: 210mm;
  height: 297mm;
  padding: 16mm 15mm 14mm;
  background: var(--paper);
  position: relative;
  overflow: hidden;
  page-break-after: always;
}}
.page:last-child {{ page-break-after: auto; }}

.ph, .pf {{
  position: absolute;
  left: 15mm;
  right: 15mm;
  display: flex;
  justify-content: space-between;
  font-size: 7.5pt;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
}}
.ph {{ top: 8mm; border-bottom: 1px solid var(--line); padding-bottom: 3.5mm; }}
.pf {{ bottom: 7mm; border-top: 1px solid var(--line); padding-top: 3.5mm; }}
.pf .pg {{ font-family: Jet, monospace; letter-spacing: 0; text-transform: none; color: var(--navy); }}

h1 {{
  font-family: NotoDisp, Inter, sans-serif;
  font-size: 18.5pt;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.12;
  margin: 2.5mm 0 3mm;
  color: var(--navy);
}}
h2 {{
  font-family: NotoDisp, Inter, sans-serif;
  font-size: 11pt;
  margin: 4.5mm 0 2mm;
  color: var(--navy);
}}
p {{ margin: 0 0 2.6mm; }}
.lede {{ color: var(--muted); font-size: 10.2pt; max-width: 46em; }}

.kicker {{
  font-size: 7.8pt;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--teal);
  font-weight: 700;
  margin: 0;
}}

.chart {{
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 4mm 4.2mm 3.6mm;
  margin: 0 0 2mm;
}}
.row {{
  display: grid;
  gap: 3mm;
  align-items: stretch;
}}
.r2 {{ grid-template-columns: 1fr 1fr; }}
.r3 {{ grid-template-columns: 1fr 1fr 1fr; }}
.r4 {{ grid-template-columns: 1fr 1fr 1fr 1fr; }}
.r5 {{ grid-template-columns: 1.1fr 1fr 1fr 1fr 1.05fr; }}
.mid {{ width: 62%; margin: 0 auto; }}
.wide3 {{ width: 84%; margin: 0 auto; }}

.node {{
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2.3mm 3mm 2.4mm 3.4mm;
  border-left: 3.5px solid var(--navy);
  min-height: 16mm;
}}
.node strong {{
  display: block;
  font-size: 9.4pt;
  font-weight: 600;
  color: var(--navy);
  margin: 0 0 0.8mm;
  line-height: 1.2;
}}
.node span {{
  display: block;
  font-size: 8pt;
  color: var(--muted);
  line-height: 1.32;
}}
.node.amber {{ border-left-color: var(--amber); }}
.node.teal {{ border-left-color: var(--teal); }}
.node.sage {{ border-left-color: var(--sage); }}
.node.coral {{ border-left-color: var(--coral); background: #FDF4F2; }}
.node.navy {{ border-left-color: var(--navy); }}
.node.ink {{
  background: var(--navy);
  border-color: var(--navy);
  color: #F3EFE6;
}}
.node.ink strong {{ color: #F3EFE6; }}
.node.ink span {{ color: #B7C4C6; }}
.node.soft {{ background: var(--soft); }}
.node.ok {{ background: #EEF6EE; border-left-color: var(--sage); }}
.node.ask {{
  background: #FFF6EA;
  border-left-color: var(--amber);
  text-align: center;
  min-height: 12mm;
}}

.arrow-d {{
  height: 7.2mm;
  display: flex;
  justify-content: center;
  align-items: stretch;
}}
.arrow-d i {{
  width: 1.4px;
  background: var(--navy);
  position: relative;
  display: block;
}}
.arrow-d i::after {{
  content: "";
  position: absolute;
  left: -3.6px;
  bottom: -1px;
  border-left: 4.4px solid transparent;
  border-right: 4.4px solid transparent;
  border-top: 5.5px solid var(--navy);
}}
.arrow-r {{
  width: 7mm;
  display: flex;
  align-items: center;
}}
.arrow-r i {{
  height: 1.4px;
  width: 100%;
  background: var(--navy);
  position: relative;
  display: block;
}}
.arrow-r i::after {{
  content: "";
  position: absolute;
  right: -1px;
  top: -3.6px;
  border-top: 4.4px solid transparent;
  border-bottom: 4.4px solid transparent;
  border-left: 5.5px solid var(--navy);
}}
.flow-h {{
  display: flex;
  align-items: stretch;
  gap: 0;
}}
.flow-h .node {{ flex: 1; }}

.cap {{
  font-size: 8.2pt;
  color: var(--muted);
  font-style: italic;
  margin: 0 0 3.2mm;
  padding: 0 0.5mm;
}}

.cards {{
  display: grid;
  gap: 3mm;
  margin: 0 0 3mm;
}}
.cards.c2 {{ grid-template-columns: 1fr 1fr; }}
.cards.c3 {{ grid-template-columns: 1fr 1fr 1fr; }}
.cards.c4 {{ grid-template-columns: 1fr 1fr 1fr 1fr; }}
.card {{
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2.6mm 3.2mm;
}}
.card h3 {{
  font-family: NotoDisp, Inter, sans-serif;
  font-size: 10pt;
  margin: 0 0 1.2mm;
  color: var(--navy);
}}
.card p {{ margin: 0; font-size: 8.3pt; color: var(--ink); }}
.card p + p {{ margin-top: 1.4mm; }}

.callout {{
  background: #E5F3F4;
  border-left: 4px solid var(--teal);
  border-radius: 0 8px 8px 0;
  padding: 2.4mm 3.2mm;
  font-size: 8.6pt;
  margin: 0 0 2mm;
}}
.callout.amber {{ background: #FFF4E4; border-left-color: var(--amber); }}
.callout.sage {{ background: #EAF4E8; border-left-color: var(--sage); }}
.callout strong {{ color: var(--navy); }}

table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 8.2pt;
  margin: 0 0 3mm;
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}}
th, td {{
  text-align: left;
  padding: 1.8mm 2.6mm;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}}
tr:last-child td {{ border-bottom: 0; }}
th {{
  font-size: 7pt;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 700;
  background: var(--soft);
}}
td.mono, .mono, code {{
  font-family: Jet, monospace;
  font-size: 0.92em;
}}
code {{
  background: var(--soft);
  padding: 0 0.28em;
  border-radius: 3px;
}}

ul.plain {{ margin: 0 0 3mm; padding-left: 4.5mm; }}
ul.plain li {{ margin: 0 0 1.1mm; }}
ol.toc {{
  margin: 0;
  padding-left: 5mm;
  columns: 2;
  column-gap: 10mm;
}}
ol.toc li {{
  break-inside: avoid;
  margin: 0 0 2.6mm;
  font-size: 9.2pt;
}}
ol.toc li strong {{ display: block; color: var(--navy); font-size: 9.6pt; }}
ol.toc li span {{ color: var(--muted); font-size: 8pt; }}

.stats {{
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 3mm;
  margin: 0 0 3mm;
}}
.stat {{
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2.4mm 3mm;
}}
.stat b {{
  display: block;
  font-family: NotoDisp, Inter, sans-serif;
  font-size: 16pt;
  color: var(--navy);
  letter-spacing: -0.03em;
  line-height: 1;
  margin-bottom: 1mm;
}}
.stat span {{ font-size: 7.8pt; color: var(--muted); }}

kbd {{
  font-family: Jet, monospace;
  font-size: 7.6pt;
  border: 1px solid var(--line);
  background: var(--white);
  border-radius: 3px;
  padding: 0.2mm 1.1mm;
}}

.legend {{
  display: flex;
  gap: 5mm;
  font-size: 7.8pt;
  color: var(--muted);
  margin: 0 0 3mm;
}}
.legend i {{
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 1.6mm;
  vertical-align: -1px;
}}

/* Cover */
.cover {{
  background: #102226;
  color: #F3EFE6;
  padding: 0;
}}
.cover-inner {{
  height: 100%;
  padding: 22mm 18mm 16mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background-image:
    radial-gradient(circle at 10px 10px, rgba(131,231,238,0.16) 3.2px, transparent 3.6px);
  background-size: 28px 28px;
  background-position: 18mm 22mm;
}}
.cover .eyebrow {{
  font-size: 9pt;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: #7ED8DE;
  font-weight: 700;
}}
.cover h1 {{
  font-size: 34pt;
  color: #F3EFE6;
  margin: 8mm 0 5mm;
  max-width: 9.4em;
}}
.cover .lede {{ color: #B7C4C6; font-size: 12pt; max-width: 34em; }}
.cover .stats .stat {{
  background: #163036;
  border: 1px solid #2A4046;
}}
.cover .stats .stat b {{ color: #7ED8DE; }}
.cover .stats .stat span {{ color: #8AA0A4; }}
.cover-foot {{
  border-top: 1px solid #2A4046;
  padding-top: 5mm;
  display: flex;
  justify-content: space-between;
  font-size: 8.5pt;
  color: #8AA0A4;
}}
.cover .chart {{
  background: transparent;
  border: 1px solid #2A4046;
  margin: 8mm 0 0;
}}
.cover .node {{
  background: #163036;
  border-color: #2A4046;
  min-height: 16mm;
}}
.cover .node strong {{ color: #F3EFE6; }}
.cover .node span {{ color: #8AA0A4; }}
.cover .arrow-d i {{ background: #7ED8DE; }}
.cover .arrow-d i::after {{ border-top-color: #7ED8DE; }}
.cover .cap {{ color: #8AA0A4; }}
"""


def page(num: int, kicker: str, title: str, body: str) -> str:
    return f"""
<section class="page">
  <header class="ph"><span>{e(kicker)}</span><span>Brickwright</span></header>
  <h1>{e(title)}</h1>
  {body}
  <footer class="pf"><span>How the application works</span><span class="pg">{num}</span></footer>
</section>
"""


def cover() -> str:
    return f"""
<section class="page cover">
  <div class="cover-inner">
    <div>
      <div class="eyebrow">Brickwright · visual guide</div>
      <h1>How this application actually works</h1>
      <p class="lede">A plain-language tour of the CAD kernel, the catalog, the 3D editor, the AI agent, saving, sharing, and the services that host it — with diagrams for the paths a person can follow.</p>
      <div class="chart">
        <div class="row r2">
          {node("A person", "Clicks and types in the editor.", "amber")}
          {node("An agent", "Talks, searches, proposes.", "teal")}
        </div>
        {arrow_d()}
        <div class="mid">{node("The CAD kernel", "Snaps, collides, revises. Same rules for both operators.", "sage")}</div>
        {arrow_d()}
        <div class="mid">{node("One document", "The only source of truth. Everything else is a view.", "navy")}</div>
      </div>
    </div>
    <div>
      <div class="stats">
        <div class="stat"><b>81,774</b><span>searchable part identities in catalog 2026-07</span></div>
        <div class="stat"><b>900</b><span>placeable parts with compiled geometry in this build</span></div>
        <div class="stat"><b>324,331</b><span>normalized connectors the snap solver can use</span></div>
      </div>
      <div class="cover-foot">
        <span>For humans who want the whole picture,<br>not a file-by-file dump.</span>
        <span style="text-align:right">Catalog build 2026-07<br>One document · two operators · no guessing</span>
      </div>
    </div>
  </div>
</section>
"""


def p_contents() -> str:
    items = [
        ("The idea", "One document. Two operators. Nothing is a sketch."),
        ("The product", "Routes, and how much each page is allowed to load."),
        ("First session", "Pick, place, move, check, export — no account needed."),
        ("Placing a brick", "A click is a ray. The kernel decides the pose."),
        ("The kernel", "Edits are transactions. Stale plans are refused."),
        ("The catalog", "Three tiers of knowing a part, said out loud."),
        ("Clutch", "How two bricks decide they are actually attached."),
        ("Checking", "Collision, connectivity, and whether it stands up."),
        ("Building at scale", "One instruction, a whole storey."),
        ("Memory", "Your computer first. The cloud is a replica."),
        ("Accounts", "Hexclave is who you are. Convex is what you share."),
        ("The assistant", "A design partner that cannot sneak a brick in."),
        ("Generation", "From a sentence to bricks that actually clutch."),
        ("Refinement", "The design doctor on a selected region."),
        ("Sharing", "A link is a photograph of a revision."),
        ("Production", "Three services behind one hostname."),
        ("The repository", "A map if you want to open the code."),
    ]
    lis = "".join(
        f"<li><strong>{e(t)}</strong><span>{e(s)}</span></li>" for t, s in items
    )
    body = f"""
<p class="lede">Seventeen short chapters. Each page is one idea, one diagram, and the rule that idea exists to protect.</p>
<div class="legend">
  <span><i style="background:#B86A12"></i>Human</span>
  <span><i style="background:#0E7A82"></i>Agent / tools</span>
  <span><i style="background:#3D7A3A"></i>Commit / success</span>
  <span><i style="background:#102226"></i>Kernel / document</span>
  <span><i style="background:#C24538"></i>Refusal</span>
</div>
<ol class="toc">{lis}</ol>
{callout("<strong>How to read a diagram.</strong> Colour is the operator, not decoration. Orange is a person. Teal is the agent or a tool. Green is a commit. Navy is the kernel. Red means the document did not change.")}
"""
    return page(2, "Contents", "What is in this guide", body)


def p_idea() -> str:
    body = f"""
<p class="lede">Brickwright is a 3D CAD program for physically buildable brick models. It is not a chat window with a picture beside it. A person and an AI agent operate the same revisioned document, the same part catalog, the same snap solver, the same undo stack, and the same 3D view.</p>
<p>If you remember only one sentence: <strong>the model document is the only source of truth</strong>. React, Three.js, chat transcripts and cloud rows are derived views. If they disagree with the document, the document wins and the views are rebuilt.</p>
<div class="chart">
  <div class="row r2">
    {node("A person", "Clicks, drags and types in the 3D editor.", "amber")}
    {node("An AI agent", "Talks, searches, proposes and captures the viewport.", "teal")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Command bus", "Same typed operations, always, in one atomic batch.", "navy")}</div>
  {arrow_d()}
  <div class="mid">{node("CAD kernel", "Guards, snaps, collides, revises. Does not know about React or Three.js.", "teal")}</div>
  {arrow_d()}
  <div class="mid">{node("The model document", "Parts, connections, revision N. This is the original.", "ink")}</div>
  {arrow_d()}
  <div class="row r4">
    {node("3D viewport", "A disposable picture.", "amber")}
    {node("Local save", "IndexedDB log.", "navy")}
    {node("Cloud copy", "Convex replica.", "teal")}
    {node("Share page", "Frozen snapshot.", "sage")}
  </div>
</div>
{cap("Everything you see is a view of one document. Humans and the agent edit it the same way.")}
<div class="stats">
  <div class="stat"><b>81,774</b><span>searchable part identities in catalog 2026-07</span></div>
  <div class="stat"><b>900</b><span>placeable parts with compiled geometry</span></div>
  <div class="stat"><b>324,331</b><span>normalized connectors the snap solver can use</span></div>
</div>
{callout("<strong>Why this matters.</strong> A language model is excellent at talking and terrible at secretly inventing a stud pitch. Brickwright lets it talk, then forces every brick through the same physics the mouse already uses. If a part cannot be placed, both of you get a teaching error rather than a fake brick.", "sage")}
"""
    return page(3, "01  ·  The idea", "One model. Two operators. Nothing is a sketch.", body)


def p_product() -> str:
    body = f"""
<p class="lede">The application is a single website with a few routes. The shell decides how much CAD a route may download before it paints. That is why the home page is a web page and the editor is a cockpit — not because two apps were glued together.</p>
<div class="chart">
  <div class="mid">{node("Landing  /", "What Brickwright is. Almost nothing is downloaded.", "ink")}</div>
  {arrow_d()}
  <div class="row r4">
    {node("Explore", "Browse real parts and demos. Needs the catalog.", "amber")}
    {node("Editor", "The CAD cockpit. Needs the kernel and your session.", "teal")}
    {node("Projects", "Your saved models. Sign-in required.", "sage")}
    {node("Gallery", "Public publications. No catalog download.", "amber")}
  </div>
  {arrow_d()}
  <div class="row r2">
    {node("Account  /account", "Sign-in and profile. Hexclave identity, not the CAD document.", "navy")}
    {node("Share  /share/:slug", "Read-only viewer of one frozen revision. Cannot edit the original.", "teal")}
  </div>
</div>
{cap("Each page only downloads what it needs. Opening the marketing site never loads a LEGO catalog.")}
<table>
  <thead><tr><th>Place</th><th>Who it is for</th><th>What is true there</th></tr></thead>
  <tbody>
    <tr><td class="mono">/</td><td>A visitor</td><td>Explains the product. Does not fetch the brick library.</td></tr>
    <tr><td class="mono">/explore</td><td>Someone browsing</td><td>Names real parts. Needs the catalog to say whether a part is real.</td></tr>
    <tr><td class="mono">/editor</td><td>A builder or an agent</td><td>The only surface that mutates a document.</td></tr>
    <tr><td class="mono">/projects</td><td>A signed-in person</td><td>Cloud and local projects. Needs an account.</td></tr>
    <tr><td class="mono">/share/…</td><td>Anyone with the link</td><td>A frozen, read-only publication.</td></tr>
    <tr><td class="mono">/gallery</td><td>The public</td><td>Published models. Still no CAD kernel.</td></tr>
    <tr><td class="mono">/account</td><td>You</td><td>Sign-in, profile. Hexclave, not the CAD document.</td></tr>
  </tbody>
</table>
{callout("<strong>Boot is staged.</strong> A route cannot promote itself. That is what keeps the home page light. If a page declared it needs the catalog and the files are missing, it refuses rather than inventing parts.")}
"""
    return page(4, "02  ·  The product", "What you can open, and what each page may load", body)


def p_session() -> str:
    body = f"""
<p class="lede">A first session does not need an account. Cloud is optional. The editor restores the last local project and you can export before you ever sign in.</p>
<h2>How much is allowed to boot</h2>
<div class="chart">
  <div class="row r3">
    {node("none", "HTML chrome only. Landing, gallery, account.", "navy")}
    {node("catalog", "Fetch and verify the compiled part library. Explore, projects, share.", "teal")}
    {node("editor", "Catalog + CAD kernel + IndexedDB session + warmed meshes.", "amber")}
  </div>
</div>
{cap("A route cannot skip ahead. The landing page is not allowed to pull the kernel even if a component asks.")}
<h2>A first session without an account</h2>
<div class="chart">
  <div class="row r3">
    {node("1  Open the editor", "Last project restores from IndexedDB.", "amber")}
    {node("2  Search  2x4", "Pick a placeable hit — one with compiled geometry.", "teal")}
    {node("3  Click the ground", "A ghost snaps. A second click commits.", "sage")}
  </div>
  {arrow_d()}
  <div class="row r3">
    {node("4  Drag with the gizmo", "One transaction on release. Escape restores the start pose.", "navy")}
    {node("5  Validate / health", "Connections, collisions, loose groups.", "amber")}
    {node("6  Export .ldr / BOM", "Or publish a share if you later sign in.", "teal")}
  </div>
</div>
{cap("Pick, place, move, check, export. That loop is the whole product, scaled up.")}
<div class="cards c2">
  <div class="card">
    <h3>Useful keys</h3>
    <p>{kbd("R")} turns the held brick. {kbd("M")} picks it up to reseat. {kbd("G")} is the move gizmo. Shift-drag box-selects. {kbd("⌘Z")} / {kbd("Ctrl+Z")} undoes the whole transaction, even if it placed a building.</p>
  </div>
  <div class="card">
    <h3>Coordinates are LDraw’s</h3>
    <p>Units are LDU. Y points down. One stud is 20 LDU; a plate is 8 LDU tall; a brick is 24. Orientation is a 3×3 matrix, not yaw/pitch/roll, so a mirrored piece round-trips into <code>.ldr</code> exactly.</p>
  </div>
</div>
"""
    return page(5, "03  ·  First session", "Pick, place, move, check, export", body)


def p_place() -> str:
    body = f"""
<p class="lede">From the chair it feels like a game: pick a 2×4, hover, click. Underneath, the viewport only supplies a ray — a line from the camera through the pixel you clicked. Everything after that is kernel work, so the ghost you see is the pose that will actually be committed.</p>
<div class="chart">
  <div class="row r3">
    {node("1  Pick", "Choose a part. It must be placeable: real compiled geometry.", "amber")}
    {node("2  Aim", "Click in the 3D view. A ray hits a brick or the ground plane.", "teal")}
    {node("3  Resolve", "The placement solver runs. Same code that will commit the pose.", "sage")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Legal pose?", "Ground rest is fine. Resting on another part without clutch is not. Occupied, incompatible and colliding poses are refused.", "ask")}</div>
  {arrow_d()}
  <div class="row r2">
    <div>
      {node("Yes — show a ghost", "Green if it will clutch. Red if blocked, with a reason. Enter respects the same rule as a click.", "ok")}
      {arrow_d()}
      {node("Commit click / Enter", "One CadOperation batch: part.add plus the connection edges it created.", "teal")}
      {arrow_d()}
      {node("Revision N + 1", "One undo step. Autosaved to the local log.", "sage")}
    </div>
    <div>
      {node("No — document unchanged", "Occupied, incompatible, collision, or no clutch. The brick is not placed.", "coral")}
    </div>
  </div>
</div>
{cap("Placing a brick is not a graphics trick. The ghost is the kernel’s real answer.")}
<div class="cards c2">
  <div class="card">
    <h3>The viewport is a picture</h3>
    <p>Three.js draws instanced meshes, studio lighting, a transform gizmo, and red/green ghosts. None of that is stored. The scene graph can be thrown away and rebuilt from the document at any time.</p>
  </div>
  <div class="card">
    <h3>A brick on a tile is illegal</h3>
    <p>Resting on the ground without a mate is fine. Resting on another part without clutch would slide. The ghost turns red and tells you why. That refusal is a kernel rule, not a UI hint.</p>
  </div>
</div>
"""
    return page(6, "04  ·  Placing a brick", "What happens when you put a brick down", body)


def p_kernel() -> str:
    body = f"""
<p class="lede">UI code and agent tools both dispatch typed operations such as <code>part.add</code>, <code>part.transform</code>, <code>part.recolor</code>. A successful batch produces exactly one new revision and one undoable transaction. Connection edges are updated as part of that same transaction, so undo removes the clutch the edit created.</p>
<div class="chart">
  <div class="row r2">
    {node("Read revision 12", "Human or agent looks at the model as it is.", "navy")}
    {node("Plan an edit", "expectedRevision = 12, plus typed operations.", "amber")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Still revision 12?", "Optimistic concurrency. The kernel re-reads the live revision before applying.", "ask")}</div>
  {arrow_d()}
  <div class="row r2">
    {node("Yes — apply atomically", "Revision becomes 13. One undo step. Connections updated with the edit.", "ok")}
    {node("No — STALE_REVISION", "Someone already edited. Repair: re-read, then replan. Nothing is overwritten.", "coral")}
  </div>
</div>
{cap("Edits are optimistic and strict. A stale plan fails with a repair hint instead of clobbering later work.")}
<h2>Rules the kernel will not bend</h2>
<ul class="plain">
  <li>The revision number only increases — including undo and redo.</li>
  <li>An agent mutation must name the exact revision it read.</li>
  <li>Protected parts and locked subassemblies cannot be silently rewritten.</li>
  <li>Only parts with compiled geometry can be placed. Catalog-only identities return <code>GEOMETRY_UNAVAILABLE</code>.</li>
  <li>Preflight (a ghost proposal) does not replace the live document.</li>
  <li>There is no fake catalog. If the compiled assets are missing, the editor refuses to start.</li>
</ul>
{callout("<strong>Command deck parity.</strong> The same assembly generators a person finds under ASSEMBLE are the tools an agent calls. “The human UI can do it but the agent cannot” is treated as a bug, not a phase.", "sage")}
"""
    return page(7, "05  ·  The kernel", "Edits are transactions, not “the mesh moved”", body)


def p_catalog() -> str:
    body = f"""
<p class="lede">The library is compiled offline from three independently licensed datasets. At runtime Brickwright does not scrape LEGO’s website and does not invent a mesh when one is missing.</p>
<div class="chart">
  <div class="row r3">
    {node("LDraw library", "Shapes, colours, part ids. CC BY 4.0.", "amber")}
    {node("LDCad Shadow Library", "How studs, pins and hinges mate. CC BY-SA 4.0.", "teal")}
    {node("Rebrickable catalogue", "Names, sets, colour evidence. Bulk CSV.", "sage")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Offline compiler  ·  catalog 2026-07", "Hashes every file. Missing assets → the app will not start.", "ink")}</div>
  {arrow_d()}
  <div class="row r3">
    {node("Placeable  ·  900", "Compiled mesh and connectors. You can build with these.", "teal")}
    {node("Modelled  ·  22,041", "LDraw knows the shape. This build has no mesh yet.", "amber")}
    {node("Catalogued  ·  58,833", "It is a real LEGO part. Nothing else is known here.", "sage")}
  </div>
</div>
{cap("Search always says which tier it found. “Never heard of it” and “real, but not placeable” are different answers.")}
<table>
  <thead><tr><th>Tier</th><th>What is known</th><th>What you can do</th></tr></thead>
  <tbody>
    <tr><td>Placeable</td><td>Mesh, envelope, LDCad connectors</td><td>Build, snap, collide, render, export</td></tr>
    <tr><td>Modelled</td><td>Official LDraw shape and connections; no mesh in this build</td><td>Inspect and search. Placing it is refused.</td></tr>
    <tr><td>Catalogued</td><td>Name, category, set appearances</td><td>Confirm it exists. The wider index is fetched only when you search past the modelled library.</td></tr>
  </tbody>
</table>
<p>Search is ranked, not filtered: an exact part number wins, then a name, then a measured size like <code>2x4</code>, then a buried word. Official-set frequency breaks ties. Asking the agent to place a search-only part teaches it to call search with <code>requireGeometry=true</code>.</p>
{callout("<strong>Licensing is not the code licence.</strong> Brickwright’s source is AGPL-3.0. The catalog bytes are derivatives of LDraw, LDCad and Rebrickable, and those terms travel with the assets. Attribution is recorded in <code>licenses.json</code>.", "amber")}
"""
    return page(8, "06  ·  The catalog", "Three levels of knowing a part", body)


def p_clutch() -> str:
    body = f"""
<p class="lede">Each placeable part carries connector frames compiled from the LDCad Shadow Library — studs, anti-studs, pins, holes, axles, clips, hinges, balls. A mate is not “close enough in space.” It is two frames brought into coincidence, with aligned axes, and a known leftover freedom (fixed, revolute, cylindrical, spherical, or honestly unknown).</p>
<div class="chart">
  <div class="row r2">
    {node("Moving brick", "Has anti-studs, pin holes, clips. Each connector is a small coordinate frame.", "amber")}
    {node("Target brick", "Already in the model. Has studs, pins, hinges — also frames.", "teal")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Find compatible pairs", "Opposite gender, same family, not already occupied.", "navy")}</div>
  {arrow_d()}
  <div class="mid">{node("Compose one rigid pose", "Tm = Tt · Ft · C · Fm⁻¹  — position and rotation together, not a slide-until-it-looks-close.", "ink")}</div>
  {arrow_d()}
  <div class="row r3">
    {node("Score extra mates", "A 2×4 should sit on eight studs, not one.", "sage")}
    {node("Axes must align", "A sideways stud through an anti-stud is not a mate.", "amber")}
    {node("Keep the best pose", "That is what the ghost shows, and what commits.", "teal")}
  </div>
</div>
{cap("Hinges and Technic pins use the same formula as ordinary stacking. A translation-only solver cannot express them at all.")}
<div class="cards c2">
  <div class="card">
    <h3>Why the formula looks scary</h3>
    <p>Start from the target brick, walk to its connector, apply the joint’s leftover wiggle, then walk back out the moving brick’s connector. You get a full pose. Studs-not-on-top and right-angle Technic fall out of the same expression as stacking.</p>
  </div>
  <div class="card">
    <h3>The graph is saved</h3>
    <p>Each mated pair is stored with when it appeared and how it was made (snap, explicit Connect, or inferred on import). That graph is what “is this one piece or three?” and “can I sequence a build guide?” are computed from.</p>
  </div>
</div>
"""
    return page(9, "07  ·  Clutch", "How two bricks decide they are actually attached", body)


def p_check() -> str:
    body = f"""
<p class="lede">A correct stack looks like an intersection in a naive model: the stud occupies the tube. So Brickwright does not shout “collision” at every legal clutch. It also does not pretend a bounding-box overlap is a proven crash.</p>
<div class="chart">
  <div class="row r3">
    {node("1  Cheap boxes", "World AABBs overlap? Fast. Many false alarms — a rotated brick’s box is huge.", "navy")}
    {node("2  Legal clutch", "Mating clearance. Studs are supposed to go into tubes. Subtract that.", "teal")}
    {node("3  Real triangles", "BVH confirmation. Do the actual surfaces meet? Cached per part definition.", "sage")}
  </div>
  {arrow_d()}
  <div class="row r3">
    {node("exact", "Triangles met. No allowance used.", "teal")}
    {node("clearance-subtracted", "Triangles met after allowing the clutch.", "amber")}
    {node("unknown", "Mesh not loaded. Only boxes were compared.", "coral")}
  </div>
</div>
{cap("The UI always shows which kind of answer you got. A box-only hit is never dressed up as proof.")}
<h2>After every committed edit</h2>
<div class="chart">
  <div class="row r4">
    {node("Connections", "Mated pairs, with joint freedom.", "teal")}
    {node("Components", "One clutched piece vs loose groups.", "navy")}
    {node("Weak points", "Only one neighbour — easy to knock off.", "amber")}
    {node("Statics", "Mass, centre of mass, support polygon, hanging loads.", "sage")}
  </div>
  {arrow_d()}
  <div class="row r3">
    {node("Colour evidence", "Unknown pairings are virtual, not illegal.", "navy")}
    {node("Hard constraints", "Palette, size, budget, locked regions.", "coral")}
    {node("Build order", "Every step must attach to what is already built.", "teal")}
  </div>
</div>
{cap("Health is measured from the connection graph and the compiled solids — not from how pretty the render looks.")}
<p>Mass and tipping come from compiled surface volume, not a made-up box. Two caveats are printed on every statics report rather than scaled away: computed mass runs a bit heavy because LDraw is an idealized solid, and clutch strength is an assumption (LEGO publishes none).</p>
"""
    return page(10, "08  ·  Checking", "Collision, connectivity, and whether it stands up", body)


def p_assembly() -> str:
    body = f"""
<p class="lede">Placing a wall brick-by-brick is where quality dies: stacked seams, unbonded corners, doors that are just holes. Parametric planners in the kernel do the bricklaying using measured part lengths from this catalog. They emit ordinary <code>part.add</code> operations, so undo, ghosts, protection and collision still apply.</p>
<div class="chart">
  <div class="row r4">
    {node("build_wall", "Bonded courses, openings, bridging above doors.", "amber")}
    {node("build_enclosure", "Four walls whose corners interlock, on a deck.", "teal")}
    {node("build_structure", "Storeys, windows, door, band, roof parapet.", "sage")}
    {node("build_field", "Floor or roof, cross-bonded into a rigid slab.", "navy")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Ordinary part.add operations", "Still one transaction, still snapped, still collision-checked.", "ink")}</div>
  {arrow_d()}
  <div class="row r3">
    {node("stack_selection", "Repeat a storey upward on its own mating planes.", "amber")}
    {node("capture_module", "Save a bay in its own local frame.", "teal")}
    {node("stamp_module", "Place copies, rotate about the footprint.", "sage")}
  </div>
</div>
{cap("A language model is bad at laying a bonded wall brick by brick. These planners do the bricklaying; the kernel still checks the result.")}
{callout("<strong>An opening is not a hole.</strong> Where the pack has a window or door that fits, it is seated as a real element and it decides how many courses the opening spans. Courses above and below bridge the edges so a doorway does not become a perforated column you could pull off with your fingers.")}
<p>You can capture a finished bay as a module and stamp it along a street, rotated about its own footprint. Four such instructions have been measured at over a thousand parts, thousands of mates, and zero collisions — still a handful of undo steps.</p>
"""
    return page(11, "09  ·  Building at scale", "One instruction, a whole storey", body)


def p_memory() -> str:
    body = f"""
<p class="lede">Every committed transaction is appended to an IndexedDB log on top of a periodic checkpoint. Reopening replays forward from the checkpoint. A gap in the log stops replay rather than applying history out of order. The save indicator tells you whether persistence is durable, memory-only, or failing.</p>
<div class="chart">
  <div class="row r3">
    {node("You click, or a wave is accepted", "Command bus → kernel commits revision N+1.", "amber")}
    {node("IndexedDB first", "Append the transaction to a local log. Periodic checkpoint. Always.", "navy")}
    {node("Outbox", "If you are signed in, queue the same edit for the cloud.", "teal")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Online and authenticated?", "Signed-out, offline and unconfigured are normal states. The editor does not freeze.", "ask")}</div>
  {arrow_d()}
  <div class="row r2">
    {node("Convex compare-and-advance", "baseRevision must match the branch head. Batches of up to 50 edits. No last-write-wins.", "ok")}
    {node("Keep working locally", "Edits stay in IndexedDB and the outbox. Sync drains later.", "amber")}
  </div>
</div>
{cap("The cloud is a replica, not the original. Your edit is durable on this computer even if the network is gone.")}
<table>
  <thead><tr><th>Situation</th><th>What happens</th></tr></thead>
  <tbody>
    <tr><td>Signed out, or Hexclave not configured</td><td>Full CAD against local storage. Honest empty account chrome.</td></tr>
    <tr><td>Offline while signed in</td><td>Edits keep landing in IndexedDB and the outbox. Sync drains later.</td></tr>
    <tr><td>Two people edited from the same revision</td><td><code>STALE_DOCUMENT</code>. Recovery can fork a conflict branch and keep both histories.</td></tr>
    <tr><td>Upload interrupted</td><td>Claims and forks are retry-safe. The same client transaction id is idempotent.</td></tr>
  </tbody>
</table>
<p>Cloud history is the same log: snapshots plus transactions, paged against a fixed revision, checksummed. A missing page is an error, not a quietly partial model.</p>
"""
    return page(12, "10  ·  Memory", "Your computer first. The cloud is a replica.", body)


def p_identity() -> str:
    body = f"""
<p class="lede">Brickwright uses Hexclave for users, authentication, email and analytics. Password, one-time codes, passkeys, Google and GitHub are enabled. The CAD kernel does not know your email. Cloud membership is keyed on the Hexclave user id inside the access token.</p>
<div class="chart">
  <div class="mid">{node("Hexclave  ·  identity plane", "Users, sessions, email, analytics.", "ink")}</div>
  {arrow_d()}
  <div class="row r3">
    {node("Password / OTP / passkey", "Or Google / GitHub.", "amber")}
    {node("Signed-in user id", "The token’s sub claim. Never an email for auth.", "teal")}
    {node("Emails", "Invites and receipts. Native Hexclave send.", "sage")}
  </div>
  {arrow_d()}
  <div class="row r2">
    {node("Browser app", "Account menu, /account, guards on /projects.", "navy")}
    {node("Convex membership", "Roles on the project. Owner / editor / viewer.", "teal")}
  </div>
</div>
{cap("Who you are and what the model is are separate planes. Cloud writes still check the Hexclave token.")}
<div class="cards c2">
  <div class="card">
    <h3>Invitations</h3>
    <p>Sharing a project with a person who is not a member yet sends mail through Hexclave. Delivery is retried with a visible status. Expired invites do not block a replacement. Email is an address to deliver to, never an authorisation key.</p>
  </div>
  <div class="card">
    <h3>Analytics are masked</h3>
    <p>Product analytics fire for shell events. CAD content — part numbers, prompts, model names that would leak a design — is masked so a session replay is not a free copy of the build.</p>
  </div>
</div>
{callout("<strong>A CAD session without Hexclave still works.</strong> That is a supported mode: a working editor with no account layer. It is also why a misconfigured deploy can look fine until you try to sign in.")}
"""
    return page(13, "11  ·  Accounts", "Hexclave is who you are. Convex is what you share.", body)


def p_agent() -> str:
    body = f"""
<p class="lede">You talk in ordinary language. The assistant reads the model through tools, plans in the same capability vocabulary as the command deck, and produces <strong>waves</strong> you review. The language model has no commit tool in any mode. The only path onto the command bus is the same accept function a person clicks.</p>
<div class="chart">
  <div class="row r4">
    {node("1  You type", "“Put a red door in that wall.”", "amber")}
    {node("2  Browser session", "Adds grounding: revision, selection, catalog version.", "navy")}
    {node("3  API process", "Holds the model key. Does not hold the document.", "teal")}
    {node("4  Anthropic", "Streams a reply and tool calls.", "sage")}
  </div>
  {arrow_d()}
  <div class="mid">{node("If the model asked for tools, the browser runs them on the real kernel", "Reads and preflights only. No commit tool exists.", "soft")}</div>
  {arrow_d()}
  <div class="row r3">
    {node("Inspect / propose", "Search, capture, ghost a proposal. Still cannot commit.", "teal")}
    {node("A reviewable wave", "You see what would change. Accept or skip.", "amber")}
    {node("Then the kernel", "Same expectedRevision guard as a mouse click.", "sage")}
  </div>
</div>
{cap("The language model never holds the bricks. Tools run in your browser; the API process only talks to the model.")}
<h2>Autonomy is a tool inventory</h2>
<div class="chart">
  <div class="row r3">
    {node("Inspect", "Read the model. Search the catalog. Capture the viewport. Cannot change a brick.", "teal")}
    {node("Propose", "Everything in Inspect, plus ghosts and preflight. Still cannot commit.", "amber")}
    {node("Build", "Writes, undo, generate, open projects — still via the kernel’s guards.", "sage")}
  </div>
</div>
{callout("<strong>Secrets stay off the page.</strong> <code>ANTHROPIC_API_KEY</code> lives in the Node API process. The browser sends a grounded transcript to <code>POST /api/assistant</code> and receives an NDJSON stream. The server keeps no session. Timeouts and byte ceilings are enforced there so the page cannot raise them.", "amber")}
"""
    return page(14, "12  ·  The assistant", "A design partner that cannot sneak a brick in", body)


def p_generate() -> str:
    body = f"""
<p class="lede">Generation is for “build me a small red fire station,” not for nudging one plate. The important trick: a candidate is never a list of guessed world coordinates. It is a <strong>build graph</strong> of part and region intents joined by connector attachments. The deterministic realiser turns each attachment into a pose with the kernel’s own snap solver. Bulk walls and decks are delegated to the parametric planners.</p>
<div class="chart">
  <div class="row r4">
    {node("1  Brief", "Words → subject, scale, colours. Conflicts are kept, not silently picked.", "amber")}
    {node("2  Graph", "Intents and attachments. No world coordinates from the model.", "teal")}
    {node("3  Realize", "Kernel solver places each attachment. Walls use planners.", "sage")}
    {node("4  Keep", "Hard gates: collision, clutch, statics, build order.", "navy")}
  </div>
</div>
{cap("A generated model is not a pile of guessed coordinates. The AI proposes structure; the kernel decides where every brick sits.")}
<p>Several candidates are produced from different structural strategies and seeds. If they are secretly the same building, the structural hash says so — you do not get three skins of one idea. Applying a candidate is one transaction at the current revision, or a refusal if the document moved.</p>
<h2>Then the design doctor</h2>
<p>Refinement is the second half of the loop. Something rough exists. You select a region and say “make the roof lower and cleaner.”</p>
<div class="chart">
  <div class="row r4">
    {node("Select a region", "And say what you want in words.", "amber")}
    {node("Analyse", "Located findings: weak, heavy, asymmetric.", "teal")}
    {node("Propose ghosts", "Restack, simplify, reinforce, symmetrize.", "sage")}
    {node("Score vector", "Every metric, including regressions.", "navy")}
  </div>
</div>
{cap("Nothing is committed until you apply. applyRefinement goes through the command bus with that proposal’s base revision.")}
<p>Heavy work can run in a web worker so the viewport stays alive. A language model, if present, may only set weights and ordering. It still does not get to invent coordinates.</p>
"""
    return page(15, "13  ·  Generation & refinement", "From a sentence, then a doctor for the rough bits", body)


def p_share() -> str:
    body = f"""
<p class="lede">Publishing captures the document at an exact revision, strips private notes and agent prompts, hashes the bytes, and freezes the object. A second write to the same slug is refused. Open Graph images are rendered from that snapshot at publish time, not fetched from a live GPU later.</p>
<div class="chart">
  <div class="row r3">
    {node("Live document", "Keeps changing as you edit.", "amber")}
    {node("Publication", "Exact revision, frozen. Private notes stripped. Content-hashed.", "teal")}
    {node("Share page", "Edge-rendered HTML. Read-only viewer. Optional fork.", "sage")}
  </div>
  {arrow_d()}
  <div class="row r4">
    {node("private", "Only you.", "navy")}
    {node("unlisted", "Unguessable link, revocable.", "amber")}
    {node("public", "Gallery and search.", "teal")}
    {node("Cannot mutate", "Viewer imports no engine or command bus.", "sage")}
  </div>
</div>
{cap("Sharing copies a moment in time. Editing the original afterwards cannot rewrite a published link.")}
<div class="cards c2">
  <div class="card">
    <h3>Forking</h3>
    <p>Forking copies the frozen model into <em>your</em> editor as a new document. The original publication stays put. That is how a gallery piece becomes something you can take apart.</p>
  </div>
  <div class="card">
    <h3>What you can take away</h3>
    <p>Where the publication allowed it: <code>.ldr</code>, MPD with submodels, BOM CSV, and a printable HTML build guide with embedded step pictures — no remote fetches.</p>
  </div>
</div>
{callout("<strong>Nothing private reaches a publication.</strong> Serialization is an allowlist, not a copy-with-deletions. Agent prompts, signed URLs, private notes and the private project id are asserted absent in tests.")}
"""
    return page(16, "14  ·  Sharing", "A share link is a photograph of a revision", body)


def p_deploy() -> str:
    body = f"""
<p class="lede">Production is <code>https://brickwrite.tech</code>. You never talk to the model API’s public hostname; an edge proxy rate-limits paid paths and forwards with a shared secret. Unproxied calls to the Vercel origin answer <code>403</code> on purpose.</p>
<div class="chart">
  <div class="mid">{node("The browser only ever talks to brickwrite.tech", "", "ink")}</div>
  {arrow_d()}
  <div class="row r3">
    {node("Cloudflare Pages", "Static app and catalog. Edge functions proxy /api and render share pages.", "amber")}
    {node("Vercel  ·  Node API", "Assistant and generation. Holds model keys. Rejects unproxied calls.", "teal")}
    {node("Convex", "Projects, history, members, comments, presence.", "sage")}
  </div>
  {arrow_d()}
  <div class="mid">{node("Hexclave", "Identity for all three. Trusted domains are environment config, not the git branch.", "navy")}</div>
</div>
{cap("Three services, three kinds of secret. A CAD session without Hexclave or Convex still works — just local, with no account.")}
<table>
  <thead><tr><th>Service</th><th>Holds</th><th>If it is missing</th></tr></thead>
  <tbody>
    <tr><td>Cloudflare Pages</td><td>The app, catalog, share HTML, API proxy</td><td>The site is down.</td></tr>
    <tr><td>Vercel Node</td><td>Assistant and generation, model keys</td><td>CAD still works. Chat and generate fail honestly.</td></tr>
    <tr><td>Convex</td><td>Project replicas and collaboration</td><td>CAD still works locally. Cloud projects unavailable.</td></tr>
    <tr><td>Hexclave</td><td>Login, email, analytics</td><td>CAD still works. Accounts unavailable.</td></tr>
  </tbody>
</table>
<p>A production build made without the Hexclave project id or Convex URL is a supported mode: a working editor with no account layer. Check those two values first if production ever shows “no Hexclave project configured.”</p>
"""
    return page(17, "15  ·  Production", "Three services behind one hostname", body)


def p_code() -> str:
    rows = [
        ("src/cad", "The kernel: document, snap, collision, assembly, save"),
        ("src/editor", "The cockpit: viewport, panels, gizmos, keyboard"),
        ("src/webmcp", "The tool surface humans and agents share"),
        ("src/agent + server/assistant", "Chat loop; tools in the browser, key on the server"),
        ("src/generation", "Sentence → brief → graph → realised bricks"),
        ("src/refinement", "Design doctor on a selected region"),
        ("src/intelligence", "Smarter part finding than keyword search"),
        ("src/cloud + convex", "Replica, membership, history, invites"),
        ("src/features", "Landing, explore, share, gallery, projects"),
        ("src/platform + hexclave", "Shell, routes, boot, accounts"),
        ("tools/", "Catalog compiler and browser acceptance tests"),
        ("functions/ + api/", "Edge proxy, share HTML, Vercel adapters"),
    ]
    tr = "".join(
        f"<tr><td class='mono'>{e(a)}</td><td>{e(b)}</td></tr>" for a, b in rows
    )
    body = f"""
<p class="lede">You do not need this page to use the product. It is here so the folders match the story above.</p>
<table>
  <thead><tr><th>Folder</th><th>What it owns</th></tr></thead>
  <tbody>{tr}</tbody>
</table>
{cap("Ten workstreams. Each owns a folder. The kernel is imported; it is never rewritten from a feature.")}
<h2>How a change is supposed to travel</h2>
<ul class="plain">
  <li>If it changes what a brick <em>is</em>, it belongs in <code>src/cad</code> and must go through operations and revisions.</li>
  <li>If it changes how a brick <em>looks or is gripped</em>, it belongs in the editor, which dispatches those operations.</li>
  <li>If it is a new agent skill, it is a tool schema plus a kernel capability — never a private back door.</li>
  <li>If it is accounts, email, or analytics, it should use Hexclave rather than a one-off service.</li>
</ul>
{callout("<strong>The test that captures the philosophy.</strong> A generated building is asserted to be bonded, collision-free, fully billed, sequenced into real steps, and undoable as the number of generator calls you made — not as a screenshot that “looks like a house.”", "sage")}
<p style="font-size:8pt;color:var(--muted);margin-top:3mm">This guide describes the application as of catalog 2026-07. Numbers are measurements of that committed build. The architecture — one document, two operators, a kernel that refuses to guess — is the part that is meant to stay true as those numbers grow.</p>
"""
    return page(18, "16  ·  The repository", "A map if you want to open the code", body)


def html_doc() -> str:
    pages = [
        cover(),
        p_contents(),
        p_idea(),
        p_product(),
        p_session(),
        p_place(),
        p_kernel(),
        p_catalog(),
        p_clutch(),
        p_check(),
        p_assembly(),
        p_memory(),
        p_identity(),
        p_agent(),
        p_generate(),
        p_share(),
        p_deploy(),
        p_code(),
    ]
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>How Brickwright works</title>
  <style>{CSS}</style>
</head>
<body>
{''.join(pages)}
</body>
</html>
"""


def print_pdf(html_path: Path, pdf_path: Path) -> None:
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    user_data = Path("/tmp/bw-chrome-pdf")
    user_data.mkdir(exist_ok=True)
    cmd = [
        "timeout",
        "40",
        "google-chrome",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        f"--user-data-dir={user_data}",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--run-all-compositor-stages-before-draw",
        f"--print-to-pdf={pdf_path}",
        "--no-pdf-header-footer",
        "--virtual-time-budget=8000",
        html_path.resolve().as_uri(),
    ]
    print("Running:", " ".join(cmd), file=sys.stderr)
    result = subprocess.run(cmd)
    if not pdf_path.exists() or pdf_path.stat().st_size < 10_000:
        raise SystemExit(f"PDF was not written (chrome exit {result.returncode})")
    # Chrome often hangs after a successful print; timeout 124 is then fine.
    if result.returncode not in (0, 124):
        raise SystemExit(f"chrome failed with exit {result.returncode}")
    print(f"Wrote {pdf_path} ({pdf_path.stat().st_size} bytes)", file=sys.stderr)


def main() -> None:
    OUT_HTML.write_text(html_doc(), encoding="utf-8")
    print(f"Wrote {OUT_HTML}", file=sys.stderr)
    print_pdf(OUT_HTML, OUT_PDF)


if __name__ == "__main__":
    main()
